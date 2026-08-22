// T16 cross-model harness tests (V16). Metrik diuji DETERMINISTIK lewat runFn yang di-inject —
// tanpa API key. Yang diuji: apakah harness benar-benar membuktikan "1 model tidak cukup",
// dan apakah refusal/error/duplikat dihitung terpisah dan jujur.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCrossModelHarness,
  summarize,
  type ModelConfig,
  type RunFn,
} from "../src/harness/crossmodel.ts";

const A: ModelConfig = { provider: "anthropic", modelId: "m-a", repetitions: 2 };
const B: ModelConfig = { provider: "deepseek", modelId: "m-b", repetitions: 2 };

/** Jam palsu deterministik: tiap pemanggilan maju 10ms. */
function fakeClock() {
  let t = 0;
  return () => (t += 10);
}

test("union coverage exceeds any single model — the core V16 claim, measured", async () => {
  // A menemukan {p1,p2}; B menemukan {p2,p3}. Tak satu pun menutup gabungan {p1,p2,p3}.
  const runFn: RunFn = async (c) =>
    c.modelId === "m-a" ? { paths: ["p1", "p2"] } : { paths: ["p2", "p3"] };

  const report = await runCrossModelHarness([A, B], runFn, fakeClock());
  assert.deepEqual(report.unionPaths, ["p1", "p2", "p3"]);
  assert.deepEqual(report.intersectionPaths, ["p2"], "hanya p2 yang ditemukan keduanya");
  assert.equal(report.bestSingleModelCoverage, 0.6667, "model terbaik cuma menutup 2/3");

  const a = report.perModel.find((m) => m.modelId === "m-a")!;
  const b = report.perModel.find((m) => m.modelId === "m-b")!;
  assert.deepEqual(a.exclusivePaths, ["p1"], "menjatuhkan A akan menghilangkan p1");
  assert.deepEqual(b.exclusivePaths, ["p3"], "menjatuhkan B akan menghilangkan p3");
});

test("summary states outright that one model is not enough (report cannot be misread)", async () => {
  const runFn: RunFn = async (c) => (c.modelId === "m-a" ? { paths: ["p1"] } : { paths: ["p2"] });
  const text = summarize(await runCrossModelHarness([A, B], runFn, fakeClock()));
  assert.match(text, /SATU MODEL TIDAK CUKUP/);
});

test("when every model finds the same paths, the summary says so instead of crying wolf", async () => {
  const runFn: RunFn = async () => ({ paths: ["p1"] });
  const report = await runCrossModelHarness([A, B], runFn, fakeClock());
  assert.equal(report.bestSingleModelCoverage, 1);
  assert.match(summarize(report), /semua konfigurasi menemukan hal yang sama/);
});

test("refusals and errors are counted SEPARATELY and never inflate coverage", async () => {
  const runFn: RunFn = async (c, attempt) => {
    if (c.modelId === "m-a") {
      return attempt === 0 ? { paths: [], refused: true } : { paths: ["p1"] };
    }
    return attempt === 0 ? { paths: [], error: "timeout" } : { paths: ["p2"] };
  };
  const report = await runCrossModelHarness([A, B], runFn, fakeClock());
  const a = report.perModel.find((m) => m.modelId === "m-a")!;
  const b = report.perModel.find((m) => m.modelId === "m-b")!;

  assert.equal(a.refusalRate, 0.5);
  assert.equal(a.errorRate, 0, "refusal ⊥ boleh terhitung sbg error");
  assert.equal(b.errorRate, 0.5);
  assert.equal(b.refusalRate, 0, "error ⊥ boleh terhitung sbg refusal");
  assert.equal(a.successfulRuns, 1, "run yang menolak ⊥ dihitung sukses");
  assert.deepEqual(a.uniquePaths, ["p1"], "run gagal ⊥ menyumbang coverage");
});

test("a thrown runFn is captured as an error rather than killing the harness", async () => {
  const runFn: RunFn = async (c) => {
    if (c.modelId === "m-a") throw new Error("provider meledak");
    return { paths: ["p2"] };
  };
  const report = await runCrossModelHarness([A, B], runFn, fakeClock());
  const a = report.perModel.find((m) => m.modelId === "m-a")!;
  assert.equal(a.errorRate, 1);
  assert.deepEqual(report.unionPaths, ["p2"], "harness tetap melaporkan hasil model lain");
});

test("duplicate rate measures repeated findings across repetitions, not distinct ones", async () => {
  // Selalu menemukan path yang sama di 2 repetisi: 4 temuan mentah, 2 unik → dup 50%.
  const runFn: RunFn = async () => ({ paths: ["p1", "p2"] });
  const report = await runCrossModelHarness([{ ...A, repetitions: 2 }], runFn, fakeClock());
  const m = report.perModel[0]!;
  assert.equal(m.totalFindings, 4);
  assert.deepEqual(m.uniquePaths, ["p1", "p2"]);
  assert.equal(m.duplicateRate, 0.5);
  assert.equal(m.runToRunConsistency, 1, "hasil identik antar-repetisi = konsisten penuh");
});

test("run-to-run variance is visible — the probabilistic reality V16 warns about", async () => {
  // Model yang sama, dua repetisi, hasil BERBEDA — persis kasus yang bikin 1 run tak cukup.
  const runFn: RunFn = async (_c, attempt) => ({ paths: attempt === 0 ? ["p1"] : ["p2"] });
  const report = await runCrossModelHarness([{ ...A, repetitions: 2 }], runFn, fakeClock());
  const m = report.perModel[0]!;
  assert.equal(m.runToRunConsistency, 0, "tidak ada irisan antar-repetisi");
  assert.deepEqual(m.uniquePaths, ["p1", "p2"], "coverage tetap gabungan kedua repetisi");
});

test("cost and runtime are aggregated per model", async () => {
  const runFn: RunFn = async () => ({ paths: ["p1"], costUsd: 0.005 });
  const report = await runCrossModelHarness([{ ...A, repetitions: 2 }], runFn, fakeClock());
  const m = report.perModel[0]!;
  assert.equal(m.totalCostUsd, 0.01);
  assert.equal(m.meanRuntimeMs, 10, "jam palsu maju 10ms per run");
});
