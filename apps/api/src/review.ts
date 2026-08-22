// T17 — Shared engineer review surface (SPEC V1, V12; kit-workflow §Human in the lead).
// Satu permukaan untuk security + product engineer: periksa bukti, tambah konteks, validasi
// severity, tetapkan owner, putuskan verdict. ⊥ membuat antrean security terpisah — semua
// bekerja di atas graph yang sama dengan yang dipakai agent.
//
// Batasan yang DISENGAJA dan harus diketahui pemakai:
//   - Auth = shared secret header, sama seperti webhook. Ini CUKUP untuk dev/kind, TIDAK
//     cukup untuk produksi multi-user: ⊥ ada identitas per-engineer, jadi `by` diambil dari
//     body dan dipercaya. Identitas nyata (SSO/OIDC) adalah pekerjaan tersendiri.
//   - Ini API-nya saja. UI web (apps/web) BELUM dibangun.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { OntologyClient } from "@openorca/ontology";
import {
  unifiedReport,
  resolveTarget,
  recordAdjudication,
  suppressionList,
  type Verdict,
} from "@openorca/agents";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const VERDICTS = ["true-positive", "false-positive", "wont-fix"] as const;
const MAX_BODY_BYTES = 64 * 1024;

export interface ReviewDeps {
  ontology: OntologyClient;
  /** Shared secret — header `X-OpenOrca-Review`. */
  secret: string;
}

const VerdictBody = z.object({
  verdict: z.enum(VERDICTS),
  by: z.string().min(1),
  remediation: z.string().optional(),
});
const SeverityBody = z.object({ severity: z.enum(SEVERITIES), by: z.string().min(1) });
const OwnerBody = z.object({ engineerEmail: z.string().min(3), by: z.string().min(1) });
const NoteBody = z.object({ note: z.string().min(1), by: z.string().min(1) });

function tql(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function nowTql(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "").concat(".000");
}
function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
function secretOk(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(sha256(provided), sha256(expected));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" }).end(payload);
}

/** Catat aksi manusia ke audit trail yang SAMA dengan aksi agent (V7). */
async function auditHuman(
  ontology: OntologyClient,
  findingId: string,
  kind: string,
  by: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const id = `HUM-${kind}-${tql(findingId)}-${Date.now().toString(36)}`;
  await ontology.write(
    `match $f isa finding, has id "${tql(findingId)}";\n` +
      `insert $a isa judge-action, links (subject: $f),\n` +
      `  has id "${id}",\n` +
      `  has evidence "${tql(JSON.stringify({ kind, by, ...detail }))}",\n` +
      `  has occurred-at ${nowTql()};`,
  );
}

async function findingExists(ontology: OntologyClient, id: string): Promise<boolean> {
  try {
    const res = await ontology.query(
      `match $f isa finding, has id "${tql(id)}"; fetch { "id": $f.id };`,
    );
    return ((res.answers as unknown[]) ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Handler review. Dipasang berdampingan dengan webhook handler; mengembalikan `false`
 * kalau request bukan miliknya, supaya handler lain bisa menanganinya.
 */
export function createReviewHandler(deps: ReviewDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!path.startsWith("/api/")) return false;

    if (!secretOk(req.headers["x-openorca-review"] as string | undefined, deps.secret)) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }

    const method = req.method ?? "GET";
    const parts = path.split("/").filter(Boolean); // ["api","findings",...]

    try {
      // GET /api/findings?service=NAME[&includeDismissed=true]
      // Memakai unifiedReport (T15) — engineer melihat finding TERGABUNG, bukan daftar mentah.
      if (method === "GET" && parts[1] === "findings" && parts.length === 2) {
        const service = url.searchParams.get("service");
        if (!service) return json(res, 400, { error: "query param `service` wajib" }), true;
        const report = await unifiedReport(deps.ontology, service, {
          includeDismissed: url.searchParams.get("includeDismissed") === "true",
        });
        return json(res, 200, { service, count: report.length, findings: report }), true;
      }

      // GET /api/findings/:id — detail + konteks routing (blast radius, owner) dari T9.
      if (method === "GET" && parts[1] === "findings" && parts.length === 3) {
        const id = decodeURIComponent(parts[2]!);
        if (!(await findingExists(deps.ontology, id))) {
          return json(res, 404, { error: "finding tidak ditemukan", id }), true;
        }
        const detail = await ontology_detail(deps.ontology, id);
        const target = await resolveTarget(deps.ontology, id);
        return json(res, 200, { ...detail, routing: target }), true;
      }

      // GET /api/suppressions?service=NAME — kenapa sebuah finding TIDAK muncul (V15).
      if (method === "GET" && parts[1] === "suppressions") {
        const service = url.searchParams.get("service");
        if (!service) return json(res, 400, { error: "query param `service` wajib" }), true;
        return json(res, 200, { service, suppressed: await suppressionList(deps.ontology, service) }), true;
      }

      // POST /api/findings/:id/{verdict|severity|owner|note}
      if (method === "POST" && parts[1] === "findings" && parts.length === 4) {
        const id = decodeURIComponent(parts[2]!);
        const action = parts[3]!;
        if (!(await findingExists(deps.ontology, id))) {
          return json(res, 404, { error: "finding tidak ditemukan", id }), true;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { error: "body bukan JSON valid" }), true;
        }

        if (action === "verdict") {
          const b = VerdictBody.safeParse(parsed);
          if (!b.success) return json(res, 400, { error: b.error.issues[0]?.message ?? "body invalid" }), true;
          const result = await recordAdjudication(deps.ontology, {
            findingId: id,
            verdict: b.data.verdict as Verdict,
            adjudicatedBy: b.data.by,
            remediation: b.data.remediation,
          });
          return json(res, 200, result), true;
        }

        if (action === "severity") {
          const b = SeverityBody.safeParse(parsed);
          if (!b.success) return json(res, 400, { error: "severity harus salah satu: " + SEVERITIES.join("|") }), true;
          await deps.ontology.write(
            `match $f isa finding, has id "${tql(id)}"; update $f has severity "${b.data.severity}";`,
          );
          await auditHuman(deps.ontology, id, "severity", b.data.by, { severity: b.data.severity });
          return json(res, 200, { findingId: id, severity: b.data.severity }), true;
        }

        if (action === "owner") {
          const b = OwnerBody.safeParse(parsed);
          if (!b.success) return json(res, 400, { error: "engineerEmail & by wajib" }), true;
          // Ownership ditautkan ke SERVICE terdampak — bukan ke finding — supaya rute
          // finding berikutnya di service itu ikut benar (owner-of, T9).
          const target = await resolveTarget(deps.ontology, id);
          if (!target) return json(res, 409, { error: "finding tidak terkait service mana pun" }), true;
          const w = await deps.ontology
            .write(
              `match\n` +
                `  $e isa engineer, has email "${tql(b.data.engineerEmail)}";\n` +
                `  $s isa service, has name "${tql(target.service)}";\n` +
                `insert (owner: $e, owned: $s) isa ownership;`,
            )
            .then(() => null)
            .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
          if (w) return json(res, 409, { error: "gagal menautkan owner (engineer terdaftar?)", detail: w }), true;
          await auditHuman(deps.ontology, id, "assign-owner", b.data.by, {
            engineerEmail: b.data.engineerEmail,
            service: target.service,
          });
          return json(res, 200, { findingId: id, service: target.service, owner: b.data.engineerEmail }), true;
        }

        if (action === "note") {
          const b = NoteBody.safeParse(parsed);
          if (!b.success) return json(res, 400, { error: "note & by wajib" }), true;
          await auditHuman(deps.ontology, id, "note", b.data.by, { note: b.data.note });
          return json(res, 201, { findingId: id, noted: true }), true;
        }

        return json(res, 404, { error: `aksi tidak dikenal: ${action}` }), true;
      }

      json(res, 404, { error: "route tidak dikenal" });
      return true;
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return true;
    }
  };
}

/** Detail 1 finding: atribut inti + jejak audit (bukti yang bisa ditantang manusia/agent). */
async function ontology_detail(ontology: OntologyClient, id: string) {
  const res = await ontology.query(
    `match $f isa finding, has id "${tql(id)}", has severity $sev, has finding-state $st;\n` +
      `fetch {\n` +
      `  "id": "${tql(id)}", "severity": $sev, "state": $st,\n` +
      `  "summary": [ match $f has summary $x; return { $x }; ],\n` +
      `  "evidence": [ match $f has evidence $x; return { $x }; ],\n` +
      `  "entryPoint": [ match $f has entry-point $x; return { $x }; ],\n` +
      `  "sink": [ match $f has sink $x; return { $x }; ],\n` +
      `  "exploitPath": [ match $f has exploit-path $x; return { $x }; ],\n` +
      `  "cweIds": [ match $f has cwe-id $x; return { $x }; ],\n` +
      `  "remediation": [ match $f has remediation $x; return { $x }; ],\n` +
      `  "verdict": [ match $f has verdict $x; return { $x }; ],\n` +
      // Subquery list yang mengembalikan >1 field HARUS pakai `fetch` bersarang — `return { $a, $b }`
      // ditolak TypeDB (FER13: "non-scalar non-reduce result cannot be represented in a list").
      `  "auditTrail": [ match $a isa agent-action, links (subject: $f), has id $aid, has evidence $aev;\n` +
      `                  fetch { "id": $aid, "evidence": $aev }; ]\n` +
      `};`,
  );
  const rows = (res.answers as Array<Record<string, unknown>>) ?? [];
  const r = rows[0] ?? {};
  const first = (v: unknown) => (Array.isArray(v) && v.length ? String(v[0]) : undefined);
  return {
    id,
    severity: String(r.severity ?? ""),
    state: String(r.state ?? ""),
    summary: first(r.summary),
    evidence: first(r.evidence),
    entryPoint: first(r.entryPoint),
    sink: first(r.sink),
    exploitPath: first(r.exploitPath),
    remediation: first(r.remediation),
    verdict: first(r.verdict),
    cweIds: (Array.isArray(r.cweIds) ? r.cweIds : []).map(String),
    auditTrail: Array.isArray(r.auditTrail) ? r.auditTrail : [],
  };
}
