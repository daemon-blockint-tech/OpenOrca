// Triage chain tests (T9/T11/T14/T15) — dijalankan terhadap TypeDB v3 NYATA memakai schema
// asli dari context/kits/kit-ontology.md (bukan schema mini), di database throwaway sendiri.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OntologyClient } from "@openorca/ontology";
import { dedupFindings } from "../src/triage/dedup.ts";
import { routeFinding, routeOpenFindings, isSuppressed } from "../src/triage/validate.ts";
import { recordAdjudication, suppressionList } from "../src/triage/learn.ts";
import { unifiedReport } from "../src/triage/report.ts";

const BASE_URL = process.env.TYPEDB_URL ?? "http://localhost:8729";
const DB = "openorca_test_triage";
const KIT = fileURLToPath(new URL("../../../context/kits/kit-ontology.md", import.meta.url));

const ontology = new OntologyClient({
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
  return fetch(`${BASE_URL}${path}`, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
}

before(async () => {
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" }).catch(() => {});
  await adminFetch(`/v1/databases/${DB}`, { method: "POST" });

  // Schema + functions VERBATIM dari kit — kalau kit berubah dan memecahkan triage, test ini gagal.
  const md = await readFile(KIT, "utf8");
  const blocks = [...md.matchAll(/```typeql\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  await ontology.schema(blocks[0]!);
  await ontology.schema(blocks[1]!);

  // Fixture: payments (punya owner) → checkout (dependency, utk blast radius), billing tanpa owner.
  await ontology.write(`insert
    $e isa engineer, has id "ENG-1", has name "Rina", has email "rina@example.com";
    $pay isa service, has id "SVC-pay", has name "payments", has repo-url "https://example/pay";
    $chk isa service, has id "SVC-chk", has name "checkout", has repo-url "https://example/chk";
    $bil isa service, has id "SVC-bil", has name "billing", has repo-url "https://example/bil";
    (owner: $e, owned: $pay) isa ownership;
    (dependee: $pay, dependent: $chk) isa dependency;`);

  // 3 finding di payments: F-a & F-c share path (duplikat), F-b beda path (distinct).
  await ontology.write(`match $svc isa service, has name "payments";
    insert
      $a isa finding, has id "F-a", has severity "high", has exploitability "likely",
        has finding-state "open", has summary "sqli di /api/pay", has evidence "ev-a",
        has entry-point "/api/pay", has sink "db.exec", has cwe-id "CWE-89",
        has exploit-path "req -> handler -> db.exec", has occurred-at 2026-08-22T00:00:00;
      $b isa finding, has id "F-b", has severity "medium", has exploitability "unlikely",
        has finding-state "open", has summary "xss di /profile", has evidence "ev-b",
        has entry-point "/profile", has sink "res.html", has cwe-id "CWE-79",
        has occurred-at 2026-08-22T00:00:00;
      $c isa finding, has id "F-c", has severity "critical", has exploitability "confirmed",
        has finding-state "open", has summary "sqli lagi (path sama)", has evidence "ev-c",
        has entry-point "/api/pay", has sink "db.exec", has cwe-id "CWE-564",
        has occurred-at 2026-08-22T00:00:00;
      (source: $a, target: $svc) isa impact;
      (source: $b, target: $svc) isa impact;
      (source: $c, target: $svc) isa impact;`);

  // Finding di billing — service TANPA owner, untuk menguji cabang no-owner.
  await ontology.write(`match $svc isa service, has name "billing";
    insert $o isa finding, has id "F-orphan", has severity "low", has exploitability "unknown",
      has finding-state "open", has summary "no owner", has evidence "ev-o",
      has entry-point "/bill", has sink "log.write", has occurred-at 2026-08-22T00:00:00;
      (source: $o, target: $svc) isa impact;`);
});

after(async () => {
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" });
});

// ---------- T14: dedup deterministik (V14) ----------

test("dedup collapses only findings sharing an identical source->sink path (V14)", async () => {
  const res = await dedupFindings(ontology, "payments");
  // F-a & F-c berbagi (/api/pay, db.exec) → 1 pasang. F-b beda path → TIDAK ikut.
  assert.deepEqual(res.created, [{ canonical: "F-a", duplicate: "F-c" }]);
  assert.equal(res.duplicates, 1);
});

test("dedup is idempotent — a second run creates nothing new", async () => {
  const res = await dedupFindings(ontology, "payments");
  assert.deepEqual(res.created, [], "rerun harus no-op");
  assert.equal(res.duplicates, 1, "tetap menghitung duplikat yang sudah ada");
});

// ---------- T9: validate & routing (V12, V14, V15) ----------

test("routeFinding routes a canonical finding to its owner with the blast radius", async () => {
  const d = await routeFinding(ontology, "F-a");
  assert.equal(d.routed, true);
  if (!d.routed) return;
  assert.equal(d.target.service, "payments");
  assert.deepEqual(d.target.owners, ["rina@example.com"]);
  // checkout bergantung pada payments → ikut terdampak (fungsi rekursif blast).
  assert.deepEqual(d.target.blastRadius, ["checkout"]);
});

test("a finding marked duplicate is NOT routed (V14) — it is reported inside its canonical", async () => {
  const d = await routeFinding(ontology, "F-c");
  assert.equal(d.routed, false);
  if (d.routed) return;
  assert.equal(d.reason, "duplicate");
});

test("a finding on a service with no owner is not routed, and says so", async () => {
  const d = await routeFinding(ontology, "F-orphan");
  assert.equal(d.routed, false);
  if (d.routed) return;
  assert.equal(d.reason, "no-owner");
  assert.equal(d.detail, "billing");
});

test("routeOpenFindings returns one auditable decision per open finding", async () => {
  const decisions = await routeOpenFindings(ontology, "payments");
  assert.deepEqual(
    decisions.map((d) => [d.finding, d.routed]),
    [["F-a", true], ["F-b", true], ["F-c", false]],
  );
});

// ---------- T15: correlate & report ----------

test("unifiedReport collapses duplicates into the canonical row and merges their CWEs", async () => {
  const report = await unifiedReport(ontology, "payments");
  assert.deepEqual(report.map((r) => r.id), ["F-a", "F-b"], "F-c muncul di dalam F-a, bukan baris sendiri");

  const unified = report.find((r) => r.id === "F-a")!;
  assert.deepEqual(unified.collapsed, ["F-c"]);
  // Severity kelompok = TERTINGGI (F-c critical), bukan severity canonical (high).
  assert.equal(unified.severity, "critical", "collapse tidak boleh menurunkan urgensi");
  assert.deepEqual(unified.cweIds, ["CWE-564", "CWE-89"], "CWE dari kedua anggota digabung");
  assert.equal(unified.exploitPath, "req -> handler -> db.exec");
});

// ---------- T11: learn & suppression (V7, V15) ----------

test("recordAdjudication writes the verdict, final state, and a judge-action audit row (V7)", async () => {
  const res = await recordAdjudication(ontology, {
    findingId: "F-b",
    verdict: "false-positive",
    adjudicatedBy: "rina@example.com",
    remediation: "input sudah di-escape oleh framework",
  });
  assert.equal(res.finalState, "dismissed");

  const check = await ontology.query(
    `match $f isa finding, has id "F-b", has verdict $v, has finding-state $s;
     $a isa judge-action, links (subject: $f), has id $aid;
     fetch { "verdict": $v, "state": $s, "audit": $aid };`,
  );
  const row = (check.answers as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.verdict, "false-positive");
  assert.equal(row.state, "dismissed");
  assert.equal(String(row.audit), res.auditId);
});

test("a dismissed finding's source->sink path suppresses future findings on it (V15)", async () => {
  // F-b sudah dismissed di test sebelumnya; path-nya kini tersuppress.
  assert.equal(await isSuppressed(ontology, "F-b"), true);

  // Finding BARU dengan path identik harus ikut tersuppress — inti V15: jangan munculkan lagi.
  await ontology.write(`match $svc isa service, has name "payments";
    insert $n isa finding, has id "F-new", has severity "medium", has exploitability "unknown",
      has finding-state "open", has summary "xss lagi", has evidence "ev-n",
      has entry-point "/profile", has sink "res.html", has occurred-at 2026-08-22T00:00:00;
      (source: $n, target: $svc) isa impact;`);

  assert.equal(await isSuppressed(ontology, "F-new"), true, "path yang sudah di-dismiss ⊥ boleh muncul lagi");
  const decision = await routeFinding(ontology, "F-new");
  assert.equal(decision.routed, false);
  if (decision.routed) return;
  assert.equal(decision.reason, "suppressed");
});

test("suppressionList explains WHICH paths are suppressed and on what basis", async () => {
  const list = await suppressionList(ontology, "payments");
  const entry = list.find((e) => e.entryPoint === "/profile")!;
  assert.ok(entry, "path yang di-dismiss harus muncul di daftar");
  assert.equal(entry.sink, "res.html");
  assert.ok(entry.basis.includes("F-b"), "harus menyebut finding dasar penekanan");
});

test("a dismissed finding drops out of the report by default but is visible on demand", async () => {
  const normal = await unifiedReport(ontology, "payments");
  assert.ok(!normal.some((r) => r.id === "F-b"), "dismissed ⊥ muncul di laporan normal");

  const full = await unifiedReport(ontology, "payments", { includeDismissed: true });
  assert.ok(full.some((r) => r.id === "F-b"), "audit lengkap tetap bisa melihatnya");
});
