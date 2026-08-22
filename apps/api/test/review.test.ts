// T17 review surface tests — HTTP nyata + TypeDB nyata (schema asli kit-ontology).
// Yang dibuktikan: auth ditegakkan, aksi manusia benar-benar mengubah graph, dan tiap aksi
// meninggalkan jejak audit (V7) di trail yang SAMA dengan aksi agent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { OntologyClient } from "@openorca/ontology";
import { createReviewHandler } from "../src/review.ts";

const BASE_URL = process.env.TYPEDB_URL ?? "http://localhost:8729";
const DB = "openorca_test_review";
const SECRET = "review-secret";
const KIT = fileURLToPath(new URL("../../../context/kits/kit-ontology.md", import.meta.url));

const ontology = new OntologyClient({
  baseUrl: BASE_URL,
  username: "admin",
  password: "password",
  databaseName: DB,
});

let server: Server;
let origin: string;

async function adminFetch(path: string, init?: RequestInit) {
  const s = await fetch(`${BASE_URL}/v1/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password" }),
  });
  const { token } = (await s.json()) as { token: string };
  return fetch(`${BASE_URL}${path}`, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: { "X-OpenOrca-Review": SECRET, "Content-Type": "application/json", ...init.headers },
  });

before(async () => {
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" }).catch(() => {});
  await adminFetch(`/v1/databases/${DB}`, { method: "POST" });
  const md = await readFile(KIT, "utf8");
  const blocks = [...md.matchAll(/```typeql\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  await ontology.schema(blocks[0]!);
  await ontology.schema(blocks[1]!);

  await ontology.write(`insert
    $e isa engineer, has id "ENG-1", has name "Rina", has email "rina@example.com";
    $s isa service, has id "SVC-pay", has name "payments", has repo-url "https://example/pay";`);
  await ontology.write(`match $svc isa service, has name "payments";
    insert $f isa finding, has id "F-1", has severity "medium", has exploitability "unknown",
      has finding-state "open", has summary "sqli", has evidence "bukti mentah",
      has entry-point "/api/pay", has sink "db.exec", has cwe-id "CWE-89",
      has occurred-at 2026-08-22T00:00:00;
      (source: $f, target: $svc) isa impact;`);

  const handler = createReviewHandler({ ontology, secret: SECRET });
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" });
});

test("requests without the shared secret are rejected before touching the graph", async () => {
  const res = await fetch(`${origin}/api/findings?service=payments`);
  assert.equal(res.status, 401);
  const wrong = await fetch(`${origin}/api/findings?service=payments`, {
    headers: { "X-OpenOrca-Review": "salah" },
  });
  assert.equal(wrong.status, 401);
});

test("GET /api/findings returns the UNIFIED report, not a raw dump", async () => {
  const res = await api("/api/findings?service=payments");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { count: number; findings: Array<{ id: string; cweIds: string[] }> };
  assert.equal(body.count, 1);
  assert.equal(body.findings[0]!.id, "F-1");
  assert.deepEqual(body.findings[0]!.cweIds, ["CWE-89"]);
});

test("GET /api/findings/:id returns evidence AND the routing context an engineer needs", async () => {
  const res = await api("/api/findings/F-1");
  assert.equal(res.status, 200);
  const b = (await res.json()) as {
    evidence?: string;
    entryPoint?: string;
    routing?: { service: string; owners: string[] };
  };
  assert.equal(b.evidence, "bukti mentah");
  assert.equal(b.entryPoint, "/api/pay");
  assert.equal(b.routing?.service, "payments");
});

test("an unknown finding id is a 404, not a 500 or a silent empty object", async () => {
  const res = await api("/api/findings/F-nope");
  assert.equal(res.status, 404);
});

test("severity validation rejects a value outside the schema enum", async () => {
  const bad = await api("/api/findings/F-1/severity", {
    method: "POST",
    body: JSON.stringify({ severity: "apocalyptic", by: "rina@example.com" }),
  });
  assert.equal(bad.status, 400);

  const ok = await api("/api/findings/F-1/severity", {
    method: "POST",
    body: JSON.stringify({ severity: "critical", by: "rina@example.com" }),
  });
  assert.equal(ok.status, 200);

  const check = await ontology.query(`match $f isa finding, has id "F-1", has severity $s; fetch { "s": $s };`);
  assert.equal(String((check.answers as Array<Record<string, unknown>>)[0]!.s), "critical");
});

test("assigning an owner links the ENGINEER to the SERVICE so future findings route too", async () => {
  const res = await api("/api/findings/F-1/owner", {
    method: "POST",
    body: JSON.stringify({ engineerEmail: "rina@example.com", by: "rina@example.com" }),
  });
  assert.equal(res.status, 200);

  // Bukti nyata: routing sekarang menemukan owner lewat fungsi owner-of.
  const detail = (await (await api("/api/findings/F-1")).json()) as { routing?: { owners: string[] } };
  assert.deepEqual(detail.routing?.owners, ["rina@example.com"]);
});

test("a note is recorded in the SAME audit trail as agent actions (V7)", async () => {
  const res = await api("/api/findings/F-1/note", {
    method: "POST",
    body: JSON.stringify({ note: "sudah dicek manual, reachable dari internet", by: "rina@example.com" }),
  });
  assert.equal(res.status, 201);

  const detail = (await (await api("/api/findings/F-1")).json()) as { auditTrail: unknown[] };
  const trail = JSON.stringify(detail.auditTrail);
  assert.match(trail, /reachable dari internet/);
  assert.match(trail, /HUM-note-F-1/, "aksi manusia ikut ternamai di trail");
});

test("recording a verdict updates state and makes the finding suppressible (V15)", async () => {
  const res = await api("/api/findings/F-1/verdict", {
    method: "POST",
    body: JSON.stringify({
      verdict: "false-positive",
      by: "rina@example.com",
      remediation: "framework sudah escape",
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { finalState: string };
  assert.equal(body.finalState, "dismissed");

  const sup = (await (await api("/api/suppressions?service=payments")).json()) as {
    suppressed: Array<{ entryPoint: string; basis: string[] }>;
  };
  assert.equal(sup.suppressed[0]!.entryPoint, "/api/pay");
  assert.ok(sup.suppressed[0]!.basis.includes("F-1"), "daftar suppression menyebut dasarnya");
});

test("a dismissed finding leaves the default queue but stays retrievable for audit", async () => {
  const normal = (await (await api("/api/findings?service=payments")).json()) as { count: number };
  assert.equal(normal.count, 0, "antrean kerja bersih dari yang sudah diputus");

  const full = (await (await api("/api/findings?service=payments&includeDismissed=true")).json()) as {
    count: number;
  };
  assert.equal(full.count, 1, "audit tetap bisa melihatnya");
});

test("a malformed JSON body is a 400, not a crash", async () => {
  const res = await api("/api/findings/F-1/note", { method: "POST", body: "{tidak valid" });
  assert.equal(res.status, 400);
});
