// T13 Foundation tests — bagian DETERMINISTIK (persist/read/gate V11) diuji terhadap TypeDB
// nyata dgn schema asli kit-ontology. Bagian pemetaan oleh LLM ⊥ diuji di sini (butuh API key);
// yang diuji adalah kontrak yang menjaga gate V11 tetap benar apa pun keluaran model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OntologyClient } from "@openorca/ontology";
import {
  ThreatModelSchema,
  persistFoundation,
  readFoundation,
  surfaceBriefing,
  foundationPrompt,
  FOUNDATION_ID_PREFIX,
} from "../src/hunt/foundation.ts";
import { foundationReady } from "../src/hunt/pipeline.ts";

const BASE_URL = process.env.TYPEDB_URL ?? "http://localhost:8729";
const DB = "openorca_test_foundation";
const KIT = fileURLToPath(new URL("../../../context/kits/kit-ontology.md", import.meta.url));

const ontology = new OntologyClient({
  baseUrl: BASE_URL,
  username: "admin",
  password: "password",
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

const SAMPLE = {
  entry_points: ["POST /api/pay", "queue: payment.settled"],
  trust_boundaries: ["internet -> gateway", "gateway -> postgres"],
  dependencies: ["express@4", "pg@8"],
  auth_paths: ["JWT bearer di middleware/auth.ts"],
  deploy_context: ["kind cluster, namespace svc-payments, Rollout canary"],
  attack_surface: ["parameter `amount` masuk query builder tanpa validasi"],
};

before(async () => {
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" }).catch(() => {});
  await adminFetch(`/v1/databases/${DB}`, { method: "POST" });
  const md = await readFile(KIT, "utf8");
  const blocks = [...md.matchAll(/```typeql\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  await ontology.schema(blocks[0]!);
  await ontology.schema(blocks[1]!);
  await ontology.write(
    `insert $s isa service, has id "SVC-pay", has name "payments", has repo-url "https://example/pay";`,
  );
});

after(async () => {
  await adminFetch(`/v1/databases/${DB}`, { method: "DELETE" });
});

test("V11 gate is CLOSED before any foundation artifact exists", async () => {
  assert.equal(await foundationReady(ontology, "payments"), false);
});

test("persistFoundation stores the full threat model and opens the V11 gate", async () => {
  const artifact = await persistFoundation(ontology, "payments", SAMPLE);
  assert.equal(artifact.id, `${FOUNDATION_ID_PREFIX}payments`);
  assert.equal(await foundationReady(ontology, "payments"), true);

  const read = await readFoundation(ontology, "payments");
  assert.ok(read, "artefak harus terbaca kembali");
  // Round-trip penuh — bukan sekadar marker: threat model harus utuh.
  assert.deepEqual(read!.model, SAMPLE);
});

test("re-running foundation REPLACES the artifact instead of stacking a stale duplicate", async () => {
  const updated = { ...SAMPLE, entry_points: ["POST /api/pay/v2"] };
  await persistFoundation(ontology, "payments", updated);

  const read = await readFoundation(ontology, "payments");
  assert.deepEqual(read!.model.entry_points, ["POST /api/pay/v2"], "harus versi terbaru");

  // Pastikan benar-benar 1 artefak, bukan 2 yang saling bertentangan.
  const rows = await ontology.query(
    `match $svc isa service, has name "payments";
     $a isa scan-action, links (subject: $svc), has id "${FOUNDATION_ID_PREFIX}payments", has evidence $ev;
     fetch { "ev": $ev };`,
  );
  assert.equal(((rows.answers as unknown[]) ?? []).length, 1);
});

test("a CORRUPT artifact keeps the V11 gate closed (fail-closed, not fail-open)", async () => {
  await ontology.write(
    `match $a isa scan-action, has id "${FOUNDATION_ID_PREFIX}payments"; delete $a;`,
  );
  await ontology.write(
    `match $svc isa service, has name "payments";
     insert $a isa scan-action, links (subject: $svc),
       has id "${FOUNDATION_ID_PREFIX}payments",
       has evidence "{ this is not valid json",
       has occurred-at 2026-08-22T00:00:00;`,
  );
  assert.equal(await readFoundation(ontology, "payments"), null);
  assert.equal(
    await foundationReady(ontology, "payments"),
    false,
    "artefak rusak ⊥ boleh dianggap foundation valid — hunt harus tetap tertahan",
  );
});

test("the threat model schema rejects a partial model (LLM cannot half-fill the gate)", () => {
  const partial = { entry_points: ["/a"], trust_boundaries: [] };
  assert.equal(ThreatModelSchema.safeParse(partial).success, false);
  assert.equal(ThreatModelSchema.safeParse(SAMPLE).success, true);
});

test("surfaceBriefing renders the surface for the Hunt prompt, incl. empty categories", () => {
  const brief = surfaceBriefing({ id: "x", service: "payments", model: { ...SAMPLE, auth_paths: [] } });
  assert.match(brief, /POST \/api\/pay/);
  assert.match(brief, /Auth paths: \(tidak ada\)/, "kategori kosong dinyatakan, bukan dihilangkan diam-diam");
});

test("the foundation prompt forbids hunting and forbids inventing findings", () => {
  const p = foundationPrompt("payments");
  assert.match(p, /jangan mencari kerentanan/i);
  assert.match(p, /JANGAN mengarang/);
});
