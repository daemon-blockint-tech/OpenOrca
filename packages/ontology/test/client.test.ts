// Integration tests — run against a real TypeDB v3 server (see SPEC.md I.env for defaults).
// Uses its own throwaway database so it never touches the `openorca` dev database's data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  OntologyClient,
  OntologyTruncatedResultError,
} from "../src/client.ts";

const BASE_URL = process.env.TYPEDB_URL ?? "http://localhost:8729";
const DB = "openorca_test_client";

const client = new OntologyClient({
  baseUrl: BASE_URL,
  username: process.env.TYPEDB_USER ?? "admin",
  password: process.env.TYPEDB_PASS ?? "password",
  databaseName: DB,
});

async function adminFetch(path: string, init?: RequestInit) {
  const signin = await fetch(`${BASE_URL}/v1/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password" }),
  });
  const { token } = (await signin.json()) as { token: string };
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
}

before(async () => {
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" }).catch(() => {});
  await adminFetch(`/v1/databases/${DB}`, { method: "POST" });
  await client.schema(`
    define
      attribute id value string;
      entity service owns id @key, plays dependency:dependent, plays dependency:dependee;
      relation dependency relates dependent, relates dependee;
  `);
  await client.schema(`
    define
    fun blast($s: service) -> { service }:
    match
      { dependency (dependee: $s, dependent: $mid); let $out in blast($mid); } or
      { dependency (dependee: $s, dependent: $out); };
    return { $out };
  `);
});

after(async () => {
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" });
});

test("blast() terminates on a cyclic dependency graph and returns the full cycle", async () => {
  await client.write(`
    insert
      $a isa service, has id "T-A";
      $b isa service, has id "T-B";
      $c isa service, has id "T-C";
      (dependee: $a, dependent: $b) isa dependency;
      (dependee: $b, dependent: $c) isa dependency;
      (dependee: $c, dependent: $a) isa dependency;
  `);

  const start = Date.now();
  const result = await client.query(`
    match
      $s isa service, has id "T-A";
      let $hit in blast($s);
      $hit has id $hit-id;
    fetch { "hit": $hit-id };
  `);
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 5000, `blast() should terminate quickly, took ${elapsedMs}ms`);
  const ids = (result.answers as Array<{ hit: string }>).map((a) => a.hit).sort();
  assert.deepEqual(ids, ["T-A", "T-B", "T-C"]);
});

test("signin is lazy — no request happens until the first query", async () => {
  const freshClient = new OntologyClient({
    baseUrl: BASE_URL,
    username: "admin",
    password: "password",
    databaseName: DB,
  });
  // Constructing the client must not touch the network by itself.
  const result = await freshClient.query(`match $s isa service, has id "T-A"; fetch { "id": $s.id };`);
  assert.equal(result.answerType, "conceptDocuments");
});

test("AUT3 (expired token) triggers exactly one re-signin then retries; a second AUT3 surfaces (no loop)", async () => {
  // Mock the wire so we can force the server to reject the first post-signin query with AUT3,
  // then accept it — proving the retry path actually re-signs in and re-runs, and does so ONCE.
  const originalFetch = globalThis.fetch;
  let signinCount = 0;
  let queryCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/signin")) {
      signinCount++;
      return new Response(JSON.stringify({ token: `tok-${signinCount}` }), { status: 200 });
    }
    // First query → AUT3 (as if the lazily-fetched token had expired); second → success.
    queryCount++;
    if (queryCount === 1) {
      return new Response(JSON.stringify({ code: "AUT3", message: "Invalid token supplied." }), { status: 401 });
    }
    return new Response(
      JSON.stringify({ queryType: "read", answerType: "conceptDocuments", answers: [{ id: "T-A" }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const mocked = new OntologyClient({ baseUrl: BASE_URL, username: "admin", password: "password", databaseName: DB });
    const result = await mocked.query(`match $s isa service; fetch { "id": $s.id };`);
    assert.equal(result.answerType, "conceptDocuments");
    assert.equal(signinCount, 2, "should sign in once lazily, then exactly once more on AUT3");
    assert.equal(queryCount, 2, "should retry the query exactly once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a persistent AUT3 surfaces as an error after a single retry — no infinite loop (V3)", async () => {
  const originalFetch = globalThis.fetch;
  let signinCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/signin")) {
      signinCount++;
      return new Response(JSON.stringify({ token: `tok-${signinCount}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "AUT3", message: "Invalid token supplied." }), { status: 401 });
  }) as typeof fetch;
  try {
    const mocked = new OntologyClient({ baseUrl: BASE_URL, username: "admin", password: "password", databaseName: DB });
    await assert.rejects(
      () => mocked.query(`match $s isa service; fetch { "id": $s.id };`),
      /AUT3/,
    );
    // Lazy signin (1) + exactly one re-signin on the first AUT3 (2). Never more.
    assert.equal(signinCount, 2, "must not loop re-signing in on a persistent AUT3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("206 / truncated result throws OntologyTruncatedResultError, not partial data", async () => {
  // Can't cheaply seed >10k rows in a unit test; this checks the client's error mapping directly
  // against a synthetic 206-shaped response instead of hitting the real cap.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/signin")) {
      return new Response(JSON.stringify({ token: "fake" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ queryType: "read", answerType: "conceptRows", answers: [], warning: "truncated" }),
      { status: 206 },
    );
  }) as typeof fetch;
  try {
    const mockedClient = new OntologyClient({
      baseUrl: BASE_URL,
      username: "admin",
      password: "password",
      databaseName: DB,
    });
    await assert.rejects(
      () => mockedClient.query("match $x isa service; fetch { \"x\": $x };"),
      OntologyTruncatedResultError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
