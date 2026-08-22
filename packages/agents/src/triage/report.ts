// T15 — Correlate & report: kelemahan terkait di-collapse jadi UNIFIED finding, bukan daftar
// mentah. Tiap unified finding wajib membawa exploit-path, severity, CWE, dan remediasi
// (SPEC V14; kit-workflow §Correlate & Report).
import type { OntologyClient } from "@openorca/ontology";
import { tqlString } from "./tql.ts";

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export interface UnifiedFinding {
  /** Canonical id — finding yang mewakili kelompok ini. */
  id: string;
  severity: Severity | string;
  /** Finding lain dgn source→sink path sama yang di-collapse ke sini (V14). */
  collapsed: string[];
  entryPoint?: string;
  sink?: string;
  exploitPath?: string;
  /** Gabungan CWE dari canonical + semua duplicate-nya. */
  cweIds: string[];
  remediation?: string;
  summary?: string;
  state: string;
}

/** Severity unified = yang TERTINGGI di kelompok — collapse ⊥ boleh menurunkan urgensi. */
function maxSeverity(values: string[]): string {
  let best = values[0] ?? "info";
  for (const v of values) {
    const a = SEVERITY_ORDER.indexOf(v as Severity);
    const b = SEVERITY_ORDER.indexOf(best as Severity);
    if (a > b) best = v;
  }
  return best;
}

interface RawFinding {
  id: string;
  severity: string;
  state: string;
  summary?: string;
  entryPoint?: string;
  sink?: string;
  exploitPath?: string;
  remediation?: string;
  cweIds: string[];
}

/** Ambil atribut inti semua finding milik service (multi-valued cwe-id digabung per id). */
async function fetchFindings(ontology: OntologyClient, service: string): Promise<Map<string, RawFinding>> {
  const res = await ontology.query(
    `match\n` +
      `  $svc isa service, has name "${tqlString(service)}";\n` +
      `  $f isa finding, has id $id, has severity $sev, has finding-state $state;\n` +
      `  impact (source: $f, target: $svc);\n` +
      `fetch {\n` +
      `  "id": $id, "severity": $sev, "state": $state,\n` +
      `  "summary": [ match $f has summary $x; return { $x }; ],\n` +
      `  "ep": [ match $f has entry-point $x; return { $x }; ],\n` +
      `  "sink": [ match $f has sink $x; return { $x }; ],\n` +
      `  "exploit": [ match $f has exploit-path $x; return { $x }; ],\n` +
      `  "remediation": [ match $f has remediation $x; return { $x }; ],\n` +
      `  "cwe": [ match $f has cwe-id $x; return { $x }; ]\n` +
      `};`,
  );
  const rows = (res.answers as Array<Record<string, unknown>>) ?? [];
  const out = new Map<string, RawFinding>();
  const first = (v: unknown): string | undefined => {
    const arr = Array.isArray(v) ? v : v == null ? [] : [v];
    return arr.length ? String(arr[0]) : undefined;
  };
  for (const r of rows) {
    out.set(String(r.id), {
      id: String(r.id),
      severity: String(r.severity),
      state: String(r.state),
      summary: first(r.summary),
      entryPoint: first(r.ep),
      sink: first(r.sink),
      exploitPath: first(r.exploit),
      remediation: first(r.remediation),
      cweIds: (Array.isArray(r.cwe) ? r.cwe : []).map(String),
    });
  }
  return out;
}

/** Peta canonical → daftar duplicate (dari relasi `correlation`, hasil dedup T14). */
async function fetchCollapseMap(
  ontology: OntologyClient,
  service: string,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  try {
    const res = await ontology.query(
      `match\n` +
        `  $svc isa service, has name "${tqlString(service)}";\n` +
        `  $c isa finding, has id $cid;\n` +
        `  $d isa finding, has id $did;\n` +
        `  impact (source: $c, target: $svc);\n` +
        `  correlation (canonical: $c, duplicate: $d);\n` +
        `fetch { "cid": $cid, "did": $did };`,
    );
    for (const r of ((res.answers as Array<Record<string, unknown>>) ?? [])) {
      const cid = String(r.cid);
      const list = map.get(cid) ?? [];
      list.push(String(r.did));
      map.set(cid, list);
    }
  } catch {
    /* belum ada correlation → tiap finding berdiri sendiri */
  }
  for (const list of map.values()) list.sort();
  return map;
}

/**
 * Laporan unified untuk 1 service: hanya CANONICAL yang muncul sebagai baris laporan;
 * duplicate-nya tercatat di `collapsed`, dan atributnya (CWE, remediasi, exploit-path)
 * ikut digabung supaya informasi ⊥ hilang saat collapse.
 * Default: finding dismissed/false-positive ⊥ dilaporkan (V15) — set `includeDismissed`
 * kalau memang ingin audit lengkap.
 */
export async function unifiedReport(
  ontology: OntologyClient,
  service: string,
  options: { includeDismissed?: boolean } = {},
): Promise<UnifiedFinding[]> {
  const findings = await fetchFindings(ontology, service);
  const collapseMap = await fetchCollapseMap(ontology, service);
  const duplicateIds = new Set([...collapseMap.values()].flat());

  const unified: UnifiedFinding[] = [];
  for (const f of findings.values()) {
    if (duplicateIds.has(f.id)) continue; // muncul di dalam canonical-nya, bukan sbg baris sendiri
    if (!options.includeDismissed && (f.state === "dismissed" || f.state === "resolved")) continue;

    const collapsed = collapseMap.get(f.id) ?? [];
    const members = [f, ...collapsed.map((id) => findings.get(id)).filter((x): x is RawFinding => !!x)];

    unified.push({
      id: f.id,
      severity: maxSeverity(members.map((m) => m.severity)),
      collapsed,
      entryPoint: f.entryPoint,
      sink: f.sink,
      // Ambil exploit-path/remediasi pertama yang ADA di kelompok — canonical didahulukan.
      exploitPath: members.find((m) => m.exploitPath)?.exploitPath,
      remediation: members.find((m) => m.remediation)?.remediation,
      cweIds: [...new Set(members.flatMap((m) => m.cweIds))].sort(),
      summary: f.summary,
      state: f.state,
    });
  }

  // Urut: severity tertinggi dulu, lalu id (deterministik).
  return unified.sort((a, b) => {
    const d = SEVERITY_ORDER.indexOf(b.severity as Severity) - SEVERITY_ORDER.indexOf(a.severity as Severity);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}
