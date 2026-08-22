// T16 — Cross-model harness (SPEC V16; kit-workflow §Model diversity & coverage).
// Premis yang ditegakkan di sini: coverage ⊥ boleh diklaim dari 1 run atau 1 model.
// Run agentic bersifat probabilistik, dan model berbeda menemukan permukaan serangan berbeda.
// ∴ harness menjalankan N konfigurasi × R repetisi, lalu MEMBANDINGKAN — bukan menjumlahkan.
import type { ProviderKey } from "../models/registry.ts";

export interface ModelConfig {
  provider: ProviderKey;
  modelId: string;
  /** Berapa kali konfigurasi ini diulang (V16: 1 run sukses ⊥ membuktikan coverage). */
  repetitions?: number;
}

/** Hasil 1 eksekusi run — sengaja minimal supaya `runFn` bisa apa saja (real / simulasi / replay). */
export interface RunOutcome {
  /** Path source→sink yang ditemukan run ini: "entry-point|sink". Identitas coverage. */
  paths: string[];
  /** true kalau model menolak mengerjakan (refusal) — dilacak terpisah dari error. */
  refused?: boolean;
  /** Error non-refusal (timeout, 5xx, parse gagal). */
  error?: string;
  /** Biaya run ini kalau tersedia dari provider. */
  costUsd?: number;
}

export type RunFn = (config: ModelConfig, attempt: number) => Promise<RunOutcome>;

export interface ModelMetrics {
  provider: ProviderKey;
  modelId: string;
  runs: number;
  /** Run yang menghasilkan keluaran (⊥ refusal, ⊥ error). */
  successfulRuns: number;
  /** Path unik yang pernah ditemukan konfigurasi ini di SELURUH repetisinya = coverage-nya. */
  uniquePaths: string[];
  /** Total temuan mentah (dgn duplikat lintas repetisi). */
  totalFindings: number;
  /** (total - unik) / total. Tinggi = model banyak mengulang temuan yang sama. */
  duplicateRate: number;
  refusalRate: number;
  errorRate: number;
  meanRuntimeMs: number;
  totalCostUsd: number;
  /**
   * Path yang HANYA ditemukan konfigurasi ini — bukti langsung V16: kalau nilainya > 0,
   * menjatuhkan model ini dari bauran akan MENGURANGI coverage.
   */
  exclusivePaths: string[];
  /** Stabilitas: berapa fraksi repetisi yang menemukan path yang sama persis. */
  runToRunConsistency: number;
}

export interface HarnessReport {
  perModel: ModelMetrics[];
  /** Gabungan seluruh konfigurasi — inilah coverage yang boleh diklaim (V16). */
  unionPaths: string[];
  /** Path yang ditemukan SEMUA konfigurasi — bagian "mudah" dari permukaan serangan. */
  intersectionPaths: string[];
  /**
   * Coverage konfigurasi TERBAIK tunggal ÷ coverage gabungan.
   * < 1 membuktikan satu model saja tidak cukup — angka inilah yang dilaporkan V16.
   */
  bestSingleModelCoverage: number;
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Number((part / whole).toFixed(4));
}

/**
 * Jalankan harness. `runFn` di-inject supaya harness bisa diuji deterministik tanpa API key,
 * dan supaya run nyata / replay tercatat bisa dipakai lewat jalur kode yang sama.
 * Kegagalan 1 run ⊥ menggugurkan harness — justru refusal/error adalah metrik yang dicari.
 */
export async function runCrossModelHarness(
  configs: ModelConfig[],
  runFn: RunFn,
  now: () => number = () => Date.now(),
): Promise<HarnessReport> {
  const perModel: ModelMetrics[] = [];

  for (const config of configs) {
    const reps = Math.max(1, config.repetitions ?? 1);
    const pathSets: string[][] = [];
    let refusals = 0;
    let errors = 0;
    let totalFindings = 0;
    let totalRuntime = 0;
    let totalCost = 0;

    for (let attempt = 0; attempt < reps; attempt++) {
      const started = now();
      let outcome: RunOutcome;
      try {
        outcome = await runFn(config, attempt);
      } catch (e) {
        outcome = { paths: [], error: e instanceof Error ? e.message : String(e) };
      }
      totalRuntime += now() - started;
      totalCost += outcome.costUsd ?? 0;

      if (outcome.refused) {
        refusals++;
        continue;
      }
      if (outcome.error) {
        errors++;
        continue;
      }
      totalFindings += outcome.paths.length;
      pathSets.push([...new Set(outcome.paths)]);
    }

    const uniquePaths = [...new Set(pathSets.flat())].sort();
    perModel.push({
      provider: config.provider,
      modelId: config.modelId,
      runs: reps,
      successfulRuns: pathSets.length,
      uniquePaths,
      totalFindings,
      duplicateRate: rate(totalFindings - uniquePaths.length, totalFindings),
      refusalRate: rate(refusals, reps),
      errorRate: rate(errors, reps),
      meanRuntimeMs: reps === 0 ? 0 : Math.round(totalRuntime / reps),
      totalCostUsd: Number(totalCost.toFixed(6)),
      exclusivePaths: [], // diisi setelah semua konfigurasi selesai
      runToRunConsistency: consistency(pathSets),
    });
  }

  // Exclusivity hanya bermakna setelah SEMUA konfigurasi dijalankan.
  for (const m of perModel) {
    const others = new Set(perModel.filter((o) => o !== m).flatMap((o) => o.uniquePaths));
    m.exclusivePaths = m.uniquePaths.filter((p) => !others.has(p));
  }

  const unionPaths = [...new Set(perModel.flatMap((m) => m.uniquePaths))].sort();
  const withFindings = perModel.filter((m) => m.uniquePaths.length > 0);
  const intersectionPaths =
    withFindings.length === 0
      ? []
      : withFindings
          .reduce<string[]>(
            (acc, m) => acc.filter((p) => m.uniquePaths.includes(p)),
            [...withFindings[0]!.uniquePaths],
          )
          .sort();

  const best = Math.max(0, ...perModel.map((m) => m.uniquePaths.length));
  return {
    perModel,
    unionPaths,
    intersectionPaths,
    bestSingleModelCoverage: rate(best, unionPaths.length),
  };
}

/** Fraksi kesamaan antar-repetisi (Jaccard rata-rata pasangan). 1 = selalu identik. */
function consistency(pathSets: string[][]): number {
  if (pathSets.length < 2) return pathSets.length === 1 ? 1 : 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < pathSets.length; i++) {
    for (let j = i + 1; j < pathSets.length; j++) {
      const a = new Set(pathSets[i]!);
      const b = new Set(pathSets[j]!);
      const inter = [...a].filter((x) => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      sum += union === 0 ? 1 : inter / union;
      pairs++;
    }
  }
  return Number((sum / pairs).toFixed(4));
}

/**
 * Ringkasan siap-baca untuk manusia. Sengaja menyatakan SECARA EKSPLISIT kalau satu model
 * tidak cukup — supaya laporan ⊥ bisa dibaca seolah "sudah lengkap" (V16).
 */
export function summarize(report: HarnessReport): string {
  const lines: string[] = [];
  lines.push(`Coverage gabungan: ${report.unionPaths.length} path unik`);
  lines.push(
    `Model tunggal terbaik menutup ${(report.bestSingleModelCoverage * 100).toFixed(1)}% dari gabungan` +
      (report.bestSingleModelCoverage < 1
        ? " — SATU MODEL TIDAK CUKUP (V16)."
        : " — semua konfigurasi menemukan hal yang sama pada set uji ini."),
  );
  for (const m of report.perModel) {
    lines.push(
      `  ${m.provider}:${m.modelId} — unik ${m.uniquePaths.length}, eksklusif ${m.exclusivePaths.length}, ` +
        `dup ${(m.duplicateRate * 100).toFixed(0)}%, refusal ${(m.refusalRate * 100).toFixed(0)}%, ` +
        `error ${(m.errorRate * 100).toFixed(0)}%, konsistensi ${(m.runToRunConsistency * 100).toFixed(0)}%, ` +
        `${m.meanRuntimeMs}ms/run, $${m.totalCostUsd}`,
    );
  }
  return lines.join("\n");
}
