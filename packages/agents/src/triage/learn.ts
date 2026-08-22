// T11 — Learn: adjudikasi analyst (verdict + remediation) masuk graph sebagai pengetahuan
// organisasi terstruktur (SPEC V7), supaya run BERIKUTNYA menekan finding yang sudah
// di-dismiss alih-alih memunculkannya lagi (V15).
import type { OntologyClient } from "@openorca/ontology";
import { tqlString, tqlNow } from "./tql.ts";

export type Verdict = "true-positive" | "false-positive" | "wont-fix";

export interface AdjudicationInput {
  findingId: string;
  verdict: Verdict;
  /** Email engineer yang memutuskan — dicatat sbg bukti, bukan sekadar log. */
  adjudicatedBy?: string;
  /** Panduan remediasi (dipakai unified report, T15). */
  remediation?: string;
}

export interface AdjudicationResult {
  findingId: string;
  verdict: Verdict;
  finalState: "resolved" | "dismissed";
  auditId: string;
}

/**
 * Verdict → state final:
 *   true-positive  → "resolved"  (nyata; ditutup setelah remediasi)
 *   false-positive → "dismissed" (bukan masalah — akan disuppress di run berikutnya, V15)
 *   wont-fix       → "dismissed" (risiko diterima sadar — juga disuppress)
 */
function finalStateFor(verdict: Verdict): "resolved" | "dismissed" {
  return verdict === "true-positive" ? "resolved" : "dismissed";
}

/**
 * Catat adjudikasi ke graph: update finding + tulis `judge-action` (audit V7).
 * Audit ditulis SETELAH update berhasil supaya ⊥ ada jejak keputusan yang tak tercermin di data.
 */
export async function recordAdjudication(
  ontology: OntologyClient,
  input: AdjudicationInput,
): Promise<AdjudicationResult> {
  const finalState = finalStateFor(input.verdict);
  const remediationClause = input.remediation
    ? `, has remediation "${tqlString(input.remediation)}"`
    : "";

  await ontology.write(
    `match $f isa finding, has id "${tqlString(input.findingId)}";\n` +
      `update $f has verdict "${input.verdict}", has finding-state "${finalState}"${remediationClause};`,
  );

  const auditId = `JDG-${tqlString(input.findingId)}-${Date.now().toString(36)}`;
  await ontology.write(
    `match $f isa finding, has id "${tqlString(input.findingId)}";\n` +
      `insert $a isa judge-action, links (subject: $f),\n` +
      `  has id "${auditId}",\n` +
      `  has evidence "${tqlString(
        JSON.stringify({
          verdict: input.verdict,
          finalState,
          by: input.adjudicatedBy ?? "unknown",
          remediation: input.remediation ?? null,
        }),
      )}",\n` +
      `  has occurred-at ${tqlNow()};`,
  );

  return { findingId: input.findingId, verdict: input.verdict, finalState, auditId };
}

export interface SuppressionEntry {
  /** Path akar-masalah yang ditekan. */
  entryPoint: string;
  sink: string;
  /** Finding yang jadi dasar penekanan (sudah dismissed / false-positive). */
  basis: string[];
}

/**
 * Daftar source→sink path yang akan ditekan pada run berikutnya (V15) untuk 1 service.
 * Dipakai Hunt/Validate untuk menjelaskan KENAPA sebuah finding tidak di-route — bukan
 * sekadar menghilang diam-diam.
 */
export async function suppressionList(
  ontology: OntologyClient,
  service: string,
): Promise<SuppressionEntry[]> {
  const q =
    `match\n` +
    `  $svc isa service, has name "${tqlString(service)}";\n` +
    `  $f isa finding, has id $id, has entry-point $ep, has sink $sink;\n` +
    `  impact (source: $f, target: $svc);\n` +
    `  { $f has verdict "false-positive"; } or { $f has finding-state "dismissed"; };\n` +
    `fetch { "id": $id, "ep": $ep, "sink": $sink };`;
  let rows: Array<Record<string, unknown>> = [];
  try {
    const res = await ontology.query(q);
    rows = (res.answers as Array<Record<string, unknown>>) ?? [];
  } catch {
    return [];
  }

  const byPath = new Map<string, SuppressionEntry>();
  for (const r of rows) {
    const entryPoint = String(r.ep);
    const sink = String(r.sink);
    const key = `${entryPoint} ${sink}`;
    const existing = byPath.get(key);
    if (existing) {
      if (!existing.basis.includes(String(r.id))) existing.basis.push(String(r.id));
    } else {
      byPath.set(key, { entryPoint, sink, basis: [String(r.id)] });
    }
  }
  for (const e of byPath.values()) e.basis.sort();
  return [...byPath.values()].sort((a, b) =>
    `${a.entryPoint} ${a.sink}`.localeCompare(`${b.entryPoint} ${b.sink}`),
  );
}
