// T9 — Validate: tentukan exploitability nyata lewat konteks graph, lalu route finding
// TERVALIDASI ke engineer pemilik (SPEC V12, V15; kit-workflow §Validate).
// Urutan wajib: suppression (V15) → duplicate check (V14) → blast radius → owner routing.
import type { OntologyClient } from "@openorca/ontology";
import { tqlString } from "./tql.ts";

export interface RouteTarget {
  /** Service yang terdampak langsung (target relasi `impact`). */
  service: string;
  /** Service lain yang ikut kena lewat rantai dependency (fungsi rekursif `blast`). */
  blastRadius: string[];
  /** Email engineer pemilik service terdampak (fungsi `owner-of`). */
  owners: string[];
}

export type RouteDecision =
  | { routed: true; finding: string; target: RouteTarget }
  | { routed: false; finding: string; reason: "suppressed" | "duplicate" | "no-owner" | "not-found"; detail?: string };

/**
 * V15 — apakah finding ini akar-masalahnya sudah pernah di-dismiss / dinilai false-positive?
 * Dicek lewat source→sink path yang sama (konsisten dgn dedup V14), bukan kemiripan teks.
 */
export async function isSuppressed(ontology: OntologyClient, findingId: string): Promise<boolean> {
  const q =
    `match\n` +
    `  $f isa finding, has id "${tqlString(findingId)}", has entry-point $ep, has sink $sink;\n` +
    `  $prior isa finding, has entry-point $ep, has sink $sink, has id $pid;\n` +
    `  { $prior has verdict "false-positive"; } or { $prior has finding-state "dismissed"; };\n` +
    `fetch { "pid": $pid };`;
  try {
    const res = await ontology.query(q);
    const rows = (res.answers as Array<Record<string, unknown>>) ?? [];
    // Finding bisa cocok dengan DIRINYA SENDIRI kalau dia sendiri sudah dismissed — itu tetap
    // berarti "jangan route", jadi ⊥ perlu difilter.
    return rows.length > 0;
  } catch {
    // Finding tanpa entry-point/sink ⊥ punya path → ⊥ bisa disuppress lewat jalur ini.
    return false;
  }
}

/** true kalau finding ini sudah ditandai sebagai duplicate dari finding lain (V14). */
export async function isDuplicate(ontology: OntologyClient, findingId: string): Promise<boolean> {
  const q =
    `match\n` +
    `  $d isa finding, has id "${tqlString(findingId)}";\n` +
    `  correlation (canonical: $c, duplicate: $d);\n` +
    `  $c isa finding, has id $cid;\n` +
    `fetch { "cid": $cid };`;
  try {
    const res = await ontology.query(q);
    return ((res.answers as unknown[]) ?? []).length > 0;
  } catch {
    return false;
  }
}

/** Blast radius + owner utk 1 finding — query kanonik kit-ontology.md §Query kanonik. */
export async function resolveTarget(
  ontology: OntologyClient,
  findingId: string,
): Promise<RouteTarget | null> {
  const direct = await ontology.query(
    `match\n` +
      `  $f isa finding, has id "${tqlString(findingId)}";\n` +
      `  impact (source: $f, target: $svc);\n` +
      `  $svc isa service, has name $svcname;\n` +
      `fetch { "service": $svcname };`,
  );
  const directRows = (direct.answers as Array<Record<string, unknown>>) ?? [];
  if (directRows.length === 0) return null;
  const service = String(directRows[0]!.service);

  // blast() rekursif + tabling → aman di dependency siklik (dibuktikan di kit-ontology AC2).
  const blast = await ontology
    .query(
      `match\n` +
        `  $svc isa service, has name "${tqlString(service)}";\n` +
        `  let $hit in blast($svc);\n` +
        `  $hit has name $hitname;\n` +
        `fetch { "hit": $hitname };`,
    )
    .catch(() => ({ answers: [] as unknown[] }));
  const blastRadius = [
    ...new Set(
      ((blast.answers as Array<Record<string, unknown>>) ?? [])
        .map((r) => String(r.hit))
        .filter((n) => n !== service),
    ),
  ].sort();

  const owners = await ontology
    .query(
      `match\n` +
        `  $svc isa service, has name "${tqlString(service)}";\n` +
        `  let $eng in owner-of($svc);\n` +
        `  $eng has email $mail;\n` +
        `fetch { "owner": $mail };`,
    )
    .catch(() => ({ answers: [] as unknown[] }));
  const ownerList = [
    ...new Set(((owners.answers as Array<Record<string, unknown>>) ?? []).map((r) => String(r.owner))),
  ].sort();

  return { service, blastRadius, owners: ownerList };
}

/**
 * Putuskan apakah 1 finding layak di-route ke engineer, dan ke siapa.
 * ⊥ pernah me-route finding yang: sudah disuppress (V15), duplicate (V14), atau tanpa owner.
 */
export async function routeFinding(
  ontology: OntologyClient,
  findingId: string,
): Promise<RouteDecision> {
  if (await isSuppressed(ontology, findingId)) {
    return { routed: false, finding: findingId, reason: "suppressed" };
  }
  if (await isDuplicate(ontology, findingId)) {
    return { routed: false, finding: findingId, reason: "duplicate" };
  }
  const target = await resolveTarget(ontology, findingId);
  if (!target) return { routed: false, finding: findingId, reason: "not-found" };
  if (target.owners.length === 0) {
    return { routed: false, finding: findingId, reason: "no-owner", detail: target.service };
  }
  return { routed: true, finding: findingId, target };
}

/** Route semua finding open milik 1 service; kembalikan keputusan per finding (audit-able). */
export async function routeOpenFindings(
  ontology: OntologyClient,
  service: string,
): Promise<RouteDecision[]> {
  const res = await ontology.query(
    `match\n` +
      `  $svc isa service, has name "${tqlString(service)}";\n` +
      `  $f isa finding, has finding-state "open", has id $id;\n` +
      `  impact (source: $f, target: $svc);\n` +
      `fetch { "id": $id };`,
  );
  const ids = ((res.answers as Array<Record<string, unknown>>) ?? []).map((r) => String(r.id)).sort();
  const decisions: RouteDecision[] = [];
  for (const id of ids) decisions.push(await routeFinding(ontology, id));
  return decisions;
}
