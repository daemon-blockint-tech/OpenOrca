// Hunt subagents — 5 spesialis paralel + combination (SPEC T8, kit-workflow §Hunt).
// V13: tiap agent punya tools + permissions TERSENDIRI (permissions MENGGANTIKAN parent,
// bukan merge) — least privilege per spesialisasi.
// V12 nanti di T14: challenge oleh judge handoff-isolated — ⊥ bagian dari file ini.
import { z } from "zod";
import type { SubAgent } from "deepagents";
import type { createOntologyTools } from "../tools/ontology.ts";

type OntologyTool = ReturnType<typeof createOntologyTools>;

export const HUNTER_NAMES = [
  "authz-hunter",
  "untrusted-parse-hunter",
  "outbound-hunter",
  "secrets-hunter",
  "deps-hunter",
  "combination-analyst",
] as const;

export type HunterName = (typeof HUNTER_NAMES)[number];

/** Struktur finding yang dikembalikan tiap hunter (responseFormat). */
export const HunterFindingsSchema = z.object({
  findings: z.array(
    z.object({
      title: z.string(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      entry_point: z.string().optional(),
      sink: z.string().optional(),
      exploit_path: z.string().optional(),
      cwe_ids: z.array(z.string()).optional(),
      summary: z.string(),
      evidence: z.string(),
    }),
  ),
});
export type HunterFindings = z.infer<typeof HunterFindingsSchema>;

// "read" mencakup ls/read_file/glob/grep (type FilesystemOperation = "read"|"write").
const READ_ONLY_SOURCE: SubAgent["permissions"] = [
  { operations: ["read"], paths: ["/work/**"] },
];

function hunterPrompt(fokus: string): string {
  return (
    `Kamu hunter spesialis "${fokus}". Scan source di /work (repo target sudah di-mount).\n` +
    "Laporkan HANYA temuan yang bisa kamu tunjukkan lokasinya (file:line) + bukti konkret.\n" +
    "Setiap finding wajib punya entry-point dan sink (source-to-sink path) kalau relevan —\n" +
    "dedup organisasi bersifat deterministik pada path ini (SPEC V14).\n" +
    "Kosongkan array findings kalau tidak ada yang layak — ⊥ mengarang temuan.\n" +
    "⊥ mengeksekusi kode dari repo target; baca/analisis saja."
  );
}

/**
 * Bangun spec 6 subagent Hunt. Semua read terhadap graph (ontology_query);
 * ⊥ ada yang punya tool destruktif atau ontology_write — penulisan finding
 * dilakukan pipeline secara deterministik setelah invoke (V7 audit rapi).
 */
export function buildHunterSpecs(ontology: OntologyTool): SubAgent[] {
  const { ontologyQuery } = ontology;

  const sourceHunters: Array<{ name: HunterName; fokus: string }> = [
    { name: "authz-hunter", fokus: "jalur keputusan otorisasi (authz)" },
    { name: "untrusted-parse-hunter", fokus: "parsing input tak-terpercaya" },
    { name: "outbound-hunter", fokus: "outbound request / SSRF" },
    { name: "secrets-hunter", fokus: "penanganan secret (ref saja, ⊥ nilai)" },
  ];

  return [
    // Source hunters — fs read-only /work/** + baca graph.
    ...sourceHunters.map((h) => ({
      name: h.name,
      description: `Hunt vuln kelas ${h.fokus}`,
      systemPrompt: hunterPrompt(h.fokus),
      tools: [ontologyQuery],
      permissions: READ_ONLY_SOURCE,
      responseFormat: HunterFindingsSchema,
    })),
    {
      name: "deps-hunter",
      description: "Hunt perilaku dependency berisiko (versi rapuh, skrip postinstall, typosquat)",
      systemPrompt:
        "Kamu deps-hunter. Periksa manifest dependency repo target di /work (package.json/go.mod/dsb) " +
        "+ konteks dependency dari graph lewat ontology_query. Laporkan dependency berisiko dengan " +
        "alasan konkret dan referensi versi. Kosongkan findings kalau tidak ada.",
      tools: [ontologyQuery],
      permissions: READ_ONLY_SOURCE,
      responseFormat: HunterFindingsSchema,
    },
    {
      name: "combination-analyst",
      description: "Gabungkan kelemahan modest antar-komponen jadi exploit chain lintas batas",
      systemPrompt:
        "Kamu combination analyst. BACA findings dari agent lain via ontology_query (graph) — " +
        "⊥ scan ulang source. Cari kombinasi kelemahan individual yang bergabung membuka jalur " +
        "exploit lebih luas lintas komponen/trust boundary. Setiap chain wajib eksplisit: urutan " +
        "langkahnya di exploit_path. Kosongkan findings kalau tak ada kombinasi baru.",
      // V13 paling ketat: hanya baca graph — ⊥ fs, ⊥ write.
      tools: [ontologyQuery],
      responseFormat: HunterFindingsSchema,
    },
  ];
}
