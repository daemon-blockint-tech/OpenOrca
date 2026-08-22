// T13 — Foundation stage (SPEC V7, V11; kit-workflow §Foundation).
// Agent MEMETAKAN target (repo, deps, interface, jalur auth, konteks deploy) dan mengembalikan
// hasilnya TERSTRUKTUR; penulisan ke graph dilakukan DETERMINISTIK dari sini.
//
// Kenapa bukan menyuruh LLM menulis TypeQL sendiri (pola awal di pipeline.ts):
//   1. LLM yang mengarang query = jalur tulis graph tak terbatas — bertentangan dgn V13
//      (least privilege) karena hunter cuma butuh menulis artefak, bukan mutasi bebas.
//      Konten repo pihak ketiga adalah DATA, dan data ⊥ boleh jadi perintah tulis.
//   2. Satu salah kutip TypeQL = gate V11 gagal senyap.
import { z } from "zod";
import type { OntologyClient } from "@openorca/ontology";
import { tqlString, tqlNow } from "../triage/tql.ts";

/** Prefix marker foundation — dipakai gate V11 di pipeline. */
export const FOUNDATION_ID_PREFIX = "FND-";

export const ThreatModelSchema = z.object({
  /** Titik masuk yang menerima input tak-terpercaya (rute HTTP, konsumer queue, CLI, dst). */
  entry_points: z.array(z.string()),
  /** Batas kepercayaan yang dilewati (proses↔proses, service↔db, internal↔internet). */
  trust_boundaries: z.array(z.string()),
  /** Dependency yang relevan secara keamanan (bukan seluruh lockfile). */
  dependencies: z.array(z.string()),
  /** Mekanisme auth/authz yang teramati. */
  auth_paths: z.array(z.string()),
  /** Konteks deploy: runtime, cluster/namespace, cara rilis. */
  deploy_context: z.array(z.string()),
  /** Attack surface yang disimpulkan — ini yang diberi ke hunter sebagai arahan. */
  attack_surface: z.array(z.string()),
});
export type ThreatModel = z.infer<typeof ThreatModelSchema>;

export interface FoundationArtifact {
  id: string;
  service: string;
  model: ThreatModel;
}

/** Prompt Foundation — eksplisit: JANGAN berburu, JANGAN menulis graph sendiri. */
export function foundationPrompt(service: string): string {
  return (
    `FOUNDATION stage untuk service "${service}". Repo ada di /work.\n` +
    "Petakan permukaan serangannya SAJA — jangan mencari kerentanan (itu stage Hunt berikutnya).\n" +
    "Isi setiap field: entry_points, trust_boundaries, dependencies, auth_paths,\n" +
    "deploy_context, attack_surface.\n" +
    "Dasarkan pada isi repo yang benar-benar kamu baca. Kalau sebuah kategori tidak ditemukan,\n" +
    "kembalikan array kosong — JANGAN mengarang.\n" +
    "Kembalikan HANYA struktur itu. ⊥ perlu menulis apa pun ke graph; pipeline yang menyimpannya."
  );
}

/**
 * Simpan artefak foundation sbg `scan-action` ber-id `FND-<service>` (marker gate V11) dengan
 * threat model penuh di `evidence`. Idempotent: artefak lama dihapus dulu supaya re-run
 * memperbarui, bukan menumpuk artefak usang yang saling bertentangan.
 */
export async function persistFoundation(
  ontology: OntologyClient,
  service: string,
  model: ThreatModel,
): Promise<FoundationArtifact> {
  const id = `${FOUNDATION_ID_PREFIX}${service}`;

  // Hapus artefak sebelumnya (kalau ada) — attribute `id` @key ⊥ boleh bentrok.
  await ontology
    .write(`match $a isa scan-action, has id "${tqlString(id)}"; delete $a;`)
    .catch(() => undefined);

  await ontology.write(
    `match $svc isa service, has name "${tqlString(service)}";\n` +
      `insert $a isa scan-action, links (subject: $svc),\n` +
      `  has id "${tqlString(id)}",\n` +
      `  has evidence "${tqlString(JSON.stringify(model))}",\n` +
      `  has occurred-at ${tqlNow()};`,
  );

  return { id, service, model };
}

/** Baca kembali threat model yang tersimpan (dipakai Hunt sbg arahan + oleh review surface). */
export async function readFoundation(
  ontology: OntologyClient,
  service: string,
): Promise<FoundationArtifact | null> {
  const id = `${FOUNDATION_ID_PREFIX}${service}`;
  try {
    const res = await ontology.query(
      `match\n` +
        `  $svc isa service, has name "${tqlString(service)}";\n` +
        `  $a isa scan-action, links (subject: $svc), has id "${tqlString(id)}", has evidence $ev;\n` +
        `fetch { "ev": $ev };`,
    );
    const rows = (res.answers as Array<Record<string, unknown>>) ?? [];
    if (rows.length === 0) return null;
    const parsed = ThreatModelSchema.safeParse(JSON.parse(String(rows[0]!.ev)));
    if (!parsed.success) return null; // artefak korup diperlakukan sbg "belum ada" → gate V11 tertutup
    return { id, service, model: parsed.data };
  } catch {
    return null;
  }
}

/** Ringkasan attack surface untuk disisipkan ke prompt Hunt (arahan, bukan data mentah). */
export function surfaceBriefing(artifact: FoundationArtifact): string {
  const { model } = artifact;
  const section = (label: string, items: string[]) =>
    items.length ? `${label}:\n${items.map((i) => `  - ${i}`).join("\n")}` : `${label}: (tidak ada)`;
  return [
    section("Entry points", model.entry_points),
    section("Trust boundaries", model.trust_boundaries),
    section("Auth paths", model.auth_paths),
    section("Attack surface", model.attack_surface),
  ].join("\n");
}
