#!/usr/bin/env node
// Drill Hunt→Route live (T8+T9+T14-dedup, model ngodeai/laguna-s-2.1-free):
//   clone demo repo → hunter container hardened → runDetect (foundation V11 gate +
//   parallel hunters) → dedup → route. Judge (V12) menyusul sbg kode, ⊥ di skrip.
// Env: TYPEDB_URL/USER/PASS, NGODEAI_API_KEY; opsional HUNTER_IMAGE, HUNTER_REQUIRE_RUNSC.
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "https://github.com/daemon-blockint-tech/openorca-demo-app.git";
const SERVICE = process.env.SERVICE ?? "demo";
const PROVIDER = "ngodeai";
const MODEL = "ngodeai/laguna-s-2.1-free";
const HUNTER_NAME = `openorca-hunter-${SERVICE}`;

for (const k of ["TYPEDB_URL", "TYPEDB_USER", "TYPEDB_PASS", "NGODEAI_API_KEY"]) {
  if (!process.env[k]) { console.error(`drill: env ${k} belum di-set`); process.exit(1); }
}

const { OntologyClient } = await import("../packages/ontology/src/client.ts");
const { resolveSandbox, runDetect, dedupFindings, routeOpenFindings } = await import("../packages/agents/src/index.ts");

const ontology = new OntologyClient({
  baseUrl: process.env.TYPEDB_URL,
  username: process.env.TYPEDB_USER,
  password: process.env.TYPEDB_PASS,
  databaseName: process.env.TYPEDB_DB ?? "openorca",
});

// 0. pastikan entity service ada (foundation & routing bind ke sini)
await ontology.write(
  `insert $s isa service, has id "SVC-${SERVICE}", has name "${SERVICE}", ` +
  `has repo-url "${REPO}";`,
).catch(async (e) => {
  if (!/TYR8|key|unique/i.test(e.message)) throw e;
  console.log("==> service sudah ada");
});
console.log(`==> service "${SERVICE}" siap`);

// 1. clone repo host-side, lalu docker cp ke /work dalam sandbox
const dir = mkdtempSync(join(tmpdir(), "drill-"));
execFileSync("git", ["clone", "-q", "--depth", "1", REPO, dir]);
console.log("==> repo cloned:", execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"]).toString().trim());

console.log("==> creating hunter container (hardened)...");
const containerId = await resolveSandbox("docker-gvisor", {
  name: HUNTER_NAME,
  image: process.env.HUNTER_IMAGE ?? "alpine:3.20",
  requireRunsc: process.env.HUNTER_REQUIRE_RUNSC === "true",
});
execFileSync("docker", ["exec", HUNTER_NAME, "sh", "-c", "rm -rf /work/*"]);
// docker cp menolak di container --read-only — seed via tar lewat exec (tmpfs /work tetap writable)
const tarball = execFileSync("tar", ["-C", dir, "-cf", "-", "."]);
execFileSync("docker", ["exec", "-i", HUNTER_NAME, "sh", "-c", "tar -x -C /work"], { input: tarball });
rmSync(dir, { recursive: true, force: true });
console.log("==> /work seeded:", execFileSync("docker", ["exec", HUNTER_NAME, "ls", "/work"]).toString().split("\n").join(" "));

// 2. DETECT — foundation gate + parallel hunters
const t0 = Date.now();
const result = await runDetect(
  { service: SERVICE },
  { ontology, sandbox: containerId, provider: PROVIDER, modelId: MODEL },
);
console.log(`==> runDetect selesai ${Date.now() - t0}ms: foundationRan=${result.foundationRan} findings=${result.findingIds.length}`);
for (const f of result.rawFindings) {
  console.log(`   [${f.severity}] ${f.summary.slice(0, 90)}${f.entry_point ? ` | entry:${f.entry_point}` : ""}${f.sink ? ` -> sink:${f.sink}` : ""}`);
}

// 3. TRIAGE — dedup deterministik lalu route
const dedup = await dedupFindings(ontology, SERVICE);
console.log(`==> dedup: created=${dedup.created.length} duplicates=${dedup.duplicates}`);
const decisions = await routeOpenFindings(ontology, SERVICE);
for (const d of decisions) {
  console.log(`   route ${d.finding}: ${d.routed ? "-> " + JSON.stringify(d.target) : d.reason}`);
}
console.log("==> DRILL PASSED");
