// Hunt pipeline — Detect stage end-to-end (SPEC T8, V7, V11, V13, V15-suppression ⊥ T11).
// Alur: V11 gate (foundation artifact ada di graph) → invoke deepagent (fan-out paralel
// 5 hunter + combination via task tool, diarahkan systemPrompt supervisor) → findings
// ditulis ke graph DETERMINISTIK dari sini (bukan lewat LLM) + scan-action audit (V7).
import { createDeepAgent } from "deepagents";
import type { BaseSandbox } from "deepagents";
import type { OntologyClient } from "@openorca/ontology";
import { createOntologyTools } from "../tools/ontology.ts";
import { resolveModel, type ProviderKey } from "../models/registry.ts";
import { buildHunterSpecs, HunterFindingsSchema, type HunterFindings } from "./subagents.ts";
import {
  ThreatModelSchema,
  foundationPrompt,
  persistFoundation,
  readFoundation,
  surfaceBriefing,
} from "./foundation.ts";

function tqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * V11 gate: hunt ⊥ jalan sebelum Foundation menyimpan threat model yang VALID.
 * Artefak korup/parsial diperlakukan sbg "belum ada" → gate tetap tertutup (fail-closed).
 */
export async function foundationReady(ontology: OntologyClient, service: string): Promise<boolean> {
  return (await readFoundation(ontology, service)) !== null;
}

export interface HuntDeps {
  ontology: OntologyClient;
  sandbox: BaseSandbox;
  provider: ProviderKey;
  modelId: string;
}

/** Bangun orchestrator Hunt. Model selalu via registry (V17); backend = sandbox hunter (V18). */
export function buildHuntAgent(deps: HuntDeps) {
  const ontologyTools = createOntologyTools(deps.ontology);
  return createDeepAgent({
    model: resolveModel(deps.provider, deps.modelId),
    tools: [ontologyTools.ontologyQuery, ontologyTools.ontologyWrite],
    // Hunter jalan di sandbox — backend eksekusi builtin (execute/ls/read/grep)
    // diturunkan dari BaseSandbox ini, BUKAN LocalShellBackend host (V18).
    backend: deps.sandbox,
    subagents: buildHunterSpecs(ontologyTools),
    responseFormat: HunterFindingsSchema,
  });
}

/** Tulis 1 finding + relasi impact-nya ke graph (deterministik dari pipeline, V7). */
async function persistFinding(
  ontology: OntologyClient,
  service: string,
  runTag: string,
  idx: number,
  f: HunterFindings["findings"][number],
): Promise<string> {
  const id = `F-${tqlString(service)}-${runTag}-${idx}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "").concat(".000");
  const opt = (label: string, v?: string) => (v ? `, has ${label} "${tqlString(v)}"` : "");
  const q =
    `match $svc isa service, has name "${tqlString(service)}";\n` +
    `insert $f isa finding,\n` +
    `  has id "${id}", has severity "${tqlString(f.severity)}", has finding-state "open",\n` +
    `  has summary "${tqlString(f.summary)}", has evidence "${tqlString(f.evidence)}", has occurred-at ${now}` +
    opt("entry-point", f.entry_point) +
    opt("sink", f.sink) +
    opt("exploit-path", f.exploit_path) +
    (f.cwe_ids?.length ? `, has cwe-id "${f.cwe_ids.map(tqlString).join('"), has cwe-id "')}"` : "") +
    `;\n` +
    `(source: $f, target: $svc) isa impact;`;
  await ontology.write(q);
  return id;
}

export interface DetectInput {
  service: string;
  /** Repo target sudah di-clone ke /work di dalam sandbox oleh pemanggil. */
  threadId?: string;
}

export interface DetectResult {
  foundationRan: boolean;
  findingIds: string[];
  rawFindings: HunterFindings["findings"];
}

/**
 * Stage Detect penuh untuk 1 service:
 *   1. V11 gate — foundation marker; kalau belum ada → jalankan foundation dulu.
 *   2. Invoke agent: fan-out paralel hunters (1 AIMessage banyak task call).
 *   3. Persist findings + audit scan-action deterministik.
 */
export async function runDetect(input: DetectInput, deps: HuntDeps): Promise<DetectResult> {
  const agent = buildHuntAgent(deps);
  const config = { configurable: { thread_id: input.threadId ?? input.service } };

  let foundationRan = false;
  if (!(await foundationReady(deps.ontology, input.service))) {
    // Foundation dijalankan agent TERPISAH: responseFormat-nya ThreatModel, bukan findings.
    // Agent memetakan; PIPELINE yang menyimpan (deterministik) — lihat foundation.ts.
    const foundationAgent = createDeepAgent({
      model: resolveModel(deps.provider, deps.modelId),
      tools: [],
      backend: deps.sandbox,
      responseFormat: ThreatModelSchema,
    });
    const fnd = await foundationAgent.invoke(
      { messages: [{ role: "user", content: foundationPrompt(input.service) }] },
      config,
    );
    const parsedModel = ThreatModelSchema.safeParse(fnd.structuredResponse);
    if (!parsedModel.success) {
      throw new Error(`foundation mengembalikan threat model tidak valid: ${parsedModel.error.message}`);
    }
    await persistFoundation(deps.ontology, input.service, parsedModel.data);
    if (!(await foundationReady(deps.ontology, input.service))) {
      throw new Error(`foundation gagal tersimpan untuk service "${input.service}" (V11 gate tetap tertutup)`);
    }
    foundationRan = true;
  }

  // Arahan Hunt memakai attack surface hasil Foundation — bukan menyuruh hunter meraba sendiri.
  const artifact = await readFoundation(deps.ontology, input.service);
  const briefing = artifact ? surfaceBriefing(artifact) : "(threat model tidak terbaca)";

  const result = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content:
            `HUNT stage untuk service "${input.service}". Repo di /work.\n` +
            `Threat model dari Foundation:\n${briefing}\n\n` +
            "Fan-out SEMUA hunter (authz-hunter, untrusted-parse-hunter, outbound-hunter, " +
            "secrets-hunter, deps-hunter) DALAM SATU pesan — paralel (kit-workflow §Hunt).\n" +
            "Setelah semua kembali: panggil combination-analyst untuk exploit chain lintas komponen.\n" +
            "Kembalikan gabungan findings terstruktur.",
        },
      ],
    },
    config,
  );

  const parsed = HunterFindingsSchema.safeParse(result.structuredResponse);
  if (!parsed.success) {
    throw new Error(`hunt menghasilkan structuredResponse tidak valid: ${parsed.error.message}`);
  }

  const runTag = Date.now().toString(36);
  const findingIds: string[] = [];
  for (const [i, f] of parsed.data.findings.entries()) {
    findingIds.push(await persistFinding(deps.ontology, input.service, runTag, i, f));
  }

  // Audit trail run (V7) — scan-action per hunt.
  await deps.ontology.write(
    `match $svc isa service, has name "${tqlString(input.service)}";\n` +
      `insert $a isa scan-action, links (subject: $svc), has id "SCAN-${runTag}", ` +
      `has evidence "${tqlString(JSON.stringify({ hunters: 6, findings: findingIds.length }))}", ` +
      `has occurred-at ${new Date().toISOString().replace(/\.\d+Z$/, "").concat(".000")};`,
  );

  return { foundationRan, findingIds, rawFindings: parsed.data.findings };
}
