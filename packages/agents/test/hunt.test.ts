// Hunt subagents + pipeline tests — V11 gate, V13 scoping, persist deterministik (V7).
import assert from "assert/strict";
import { describe, it } from "node:test";
import { buildHunterSpecs, HUNTER_NAMES, HunterFindingsSchema } from "../src/hunt/subagents.ts";
import { foundationReady } from "../src/hunt/pipeline.ts";
import { createOntologyTools } from "../src/tools/ontology.ts";
import type { OntologyClient, QueryAnswerResponse } from "@openorca/ontology";

function mockOntology(): { client: OntologyClient; queries: string[]; writes: string[]; answers: unknown } {
  const state = { queries: [] as string[], writes: [] as string[], answers: [] as unknown };
  const client = {
    async query(q: string): Promise<QueryAnswerResponse> {
      state.queries.push(q);
      return { queryType: "read", answerType: "conceptDocuments", answers: state.answers, warning: null };
    },
    async write(q: string): Promise<QueryAnswerResponse> {
      state.writes.push(q);
      return { queryType: "write", answerType: "ok", answers: [], warning: null };
    },
    schema(): never {
      throw new Error("not used");
    },
  } as unknown as OntologyClient;
  return { client, ...state };
}

describe("hunt subagents (V13)", () => {
  const ontologyTools = createOntologyTools(mockOntology().client);
  const specs = buildHunterSpecs(ontologyTools);

  it("6 spesialis: 5 hunter + combination, nama unik", () => {
    assert.equal(specs.length, 6);
    assert.deepEqual(
      specs.map((s) => s.name).sort(),
      [...HUNTER_NAMES].sort(),
    );
  });

  it("⊥ ada hunter dengan tool destruktif atau ontology_write (least privilege)", () => {
    for (const s of specs) {
      const names = (s.tools ?? []).map((t) => t.name);
      assert.ok(!names.includes("ontology_write"), `${s.name} tidak boleh punya ontology_write`);
      for (const destructive of ["argocd_sync", "argocd_rollback", "rollout_recall", "rollout_promote"]) {
        assert.ok(!names.includes(destructive), `${s.name} tidak boleh punya ${destructive}`);
      }
    }
  });

  it("combination-analyst paling ketat: hanya ontology_query, ⊥ fs permissions", () => {
    const combo = specs.find((s) => s.name === "combination-analyst");
    assert.deepEqual(combo?.tools?.map((t) => t.name), ["ontology_query"]);
    // ⊥ permissions fs — dia ⊥ menyentuh source sama sekali
    assert.equal(combo?.permissions, undefined);
  });

  it("source hunters punya fs read-only /work/** + responseFormat findings", () => {
    for (const name of HUNTER_NAMES.filter((n) => n !== "combination-analyst")) {
      const s = specs.find((x) => x.name === name);
      assert.ok(s?.permissions?.length, `${name} harus punya permissions eksplisit (V13)`);
      assert.deepEqual(s.permissions[0]?.paths, ["/work/**"]);
      assert.ok(s.responseFormat, `${name} harus punya responseFormat`);
    }
  });

  it("schema findings: severity enum + evidence wajib", () => {
    const okParse = HunterFindingsSchema.safeParse({
      findings: [{ title: "t", severity: "high", summary: "s", evidence: "e" }],
    });
    assert.ok(okParse.success);
    const badSeverity = HunterFindingsSchema.safeParse({
      findings: [{ title: "t", severity: "apocalyptic", summary: "s", evidence: "e" }],
    });
    assert.ok(!badSeverity.success);
  });
});

describe("foundationReady (V11 gate)", () => {
  // KONTRAK DIPERKUAT (T13): dulu gate cukup melihat PREFIX id `FND-`. Itu fail-open — sebuah
  // marker tanpa threat model yang bisa dibaca berarti Foundation belum benar-benar "hasilkan
  // threat model + attack surface" seperti bunyi V11. Sekarang gate menuntut artefak yang
  // benar-benar ter-parse. Test lama juga memakai bentuk `{id:{value}}` yang bukan bentuk
  // respons HTTP TypeDB sebenarnya (plain string) — lihat foundation.test.ts utk uji live.
  it("gate terbuka hanya kalau artefak berisi threat model yang valid", async () => {
    const valid = JSON.stringify({
      entry_points: ["POST /pay"],
      trust_boundaries: [],
      dependencies: [],
      auth_paths: [],
      deploy_context: [],
      attack_surface: ["amount tanpa validasi"],
    });

    const m1 = mockOntology();
    (m1.answers as unknown[]).push({ ev: "{ bukan json" });
    assert.equal(await foundationReady(m1.client, "checkout"), false, "artefak rusak → tetap tertutup");

    const m2 = mockOntology();
    (m2.answers as unknown[]).push({ ev: valid });
    assert.equal(await foundationReady(m2.client, "checkout"), true);
  });

  it("threat model parsial ⊥ membuka gate", async () => {
    const m = mockOntology();
    (m.answers as unknown[]).push({ ev: JSON.stringify({ entry_points: ["/a"] }) });
    assert.equal(await foundationReady(m.client, "checkout"), false);
  });

  it("graph error → gate tertutup (false), ⊥ crash", async () => {
    const bad = {
      async query() {
        throw new Error("db down");
      },
    } as unknown as OntologyClient;
    assert.equal(await foundationReady(bad, "svc"), false);
  });
});
