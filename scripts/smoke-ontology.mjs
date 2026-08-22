#!/usr/bin/env node
// Smoke test (kit-ontology.md acceptance criterion 2): insert a cyclic service dependency
// graph and prove blast() terminates and returns the full cycle. Idempotent — safe to rerun.
const TYPEDB_URL = process.env.TYPEDB_URL ?? "http://localhost:8729";
const TYPEDB_USER = process.env.TYPEDB_USER ?? "admin";
const TYPEDB_PASS = process.env.TYPEDB_PASS ?? "password";
const DB = process.env.TYPEDB_DB ?? "openorca";

async function signin() {
  const res = await fetch(`${TYPEDB_URL}/v1/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TYPEDB_USER, password: TYPEDB_PASS }),
  });
  if (!res.ok) throw new Error(`signin failed: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function run(token, transactionType, query) {
  const res = await fetch(`${TYPEDB_URL}/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ databaseName: DB, transactionType, query, commit: transactionType !== "read" }),
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const token = await signin();

  const insertResult = await run(
    token,
    "write",
    `insert
      $a isa service, has id "SMOKE-A", has name "smoke-a", has repo-url "https://example/smoke-a";
      $b isa service, has id "SMOKE-B", has name "smoke-b", has repo-url "https://example/smoke-b";
      $c isa service, has id "SMOKE-C", has name "smoke-c", has repo-url "https://example/smoke-c";
      (dependee: $a, dependent: $b) isa dependency;
      (dependee: $b, dependent: $c) isa dependency;
      (dependee: $c, dependent: $a) isa dependency;`,
  );
  if (insertResult.ok) {
    console.log("==> inserted SMOKE-A/B/C cyclic dependency graph");
  } else if (insertResult.body.code === "TYR8" || /key/i.test(insertResult.body.message ?? "")) {
    console.log("==> SMOKE-A/B/C already present (idempotent rerun), continuing");
  } else {
    throw new Error(`insert failed: ${insertResult.body.code} ${insertResult.body.message}`);
  }

  const start = Date.now();
  const blastResult = await run(
    token,
    "read",
    `match
      $s isa service, has id "SMOKE-A";
      let $hit in blast($s);
      $hit has id $hit-id;
    fetch { "hit": $hit-id };`,
  );
  const elapsedMs = Date.now() - start;

  if (!blastResult.ok) {
    throw new Error(`blast() query failed: ${blastResult.body.code} ${blastResult.body.message}`);
  }
  if (blastResult.status === 206 || blastResult.body.warning) {
    throw new Error("blast() result truncated — unexpected for a 3-node cycle");
  }

  const ids = blastResult.body.answers.map((a) => a.hit).sort();
  const expected = ["SMOKE-A", "SMOKE-B", "SMOKE-C"];
  const match = JSON.stringify(ids) === JSON.stringify(expected);

  console.log(`==> blast(SMOKE-A) -> [${ids.join(", ")}] in ${elapsedMs}ms`);
  if (!match) {
    throw new Error(`expected [${expected.join(", ")}], got [${ids.join(", ")}]`);
  }
  if (elapsedMs > 5000) {
    throw new Error(`blast() took ${elapsedMs}ms — expected fast termination on a 3-node cycle`);
  }
  console.log("==> smoke test PASSED: blast() terminates on a cyclic graph with the correct closure");
}

main().catch((err) => {
  console.error("smoke-ontology FAILED:", err.message);
  process.exit(1);
});
