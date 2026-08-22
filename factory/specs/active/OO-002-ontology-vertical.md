---
id: OO-002
title: Ontology vertical — schema + client TypeDB HTTP + tools ontology_*
agent: claude
risk: medium
grill: completed
verification:
  - "npm test -- ontology"
  - "node scripts/apply-schema.mjs && node scripts/smoke-ontology.mjs"
---

# Context

SPEC §T2–T4, invariant V2 V3 V7 V9. Schema + functions verbatim dari `context/kits/kit-ontology.md`. Client = HTTP v1 (⊥ gRPC dulu): `POST /v1/signin`, `POST /v1/query` one-shot. Jebakan wajib ditangani: cap 10k → 206 (V2), token mati saat restart → AUT3 re-signin 1x (V3). Kontrak tool: `context/kits/kit-agent-tools.md` §ontology_query/§ontology_write.

# Acceptance Criteria

Semua acceptance criteria `kit-ontology.md` (1–5) + `kit-agent-tools.md` butir 1–3. Tambahan:

1. `packages/ontology/src/client.ts` — signin lazy, retry AUT3 sekali, deteksi 206/warning → throw pesan reduce/limit. **✓ terverifikasi live 2026-08-22 — 5/5 test `packages/ontology`; AUT3 retry-once + no-loop dibuktikan via fetch-mock (bukan baseline).**
2. `scripts/apply-schema.mjs` apply schema+functions ke db `openorca`; idempotent. **✓ terverifikasi live — 2x rerun exit 0. CATATAN: `define fun` ⊥ idempotent di TypeDB (FUN5), ditangani di script (SPEC §B B8).**
3. Test siklus blast: insert A→B→C→A, `blast(A)` = {A,B,C}. **✓ `scripts/smoke-ontology.mjs` → {SMOKE-A,B,C} ~3-7ms; juga di test suite.**
4. Tools `ontology_query`/`ontology_write` ter-register di `createDeepAgent` tanpa collision. **✓ 2/2 test `packages/agents` (V9).**

# Constraints

- Dep baru: ⊥ (fetch bawaan Node). zod sudah ada via deepagents peer.
- ⊥ ORM/query-builder di atas TypeQL — string TypeQL polos.

# Review Notes

Uji V2 dgn seed >10k attribute. Uji V3 dgn restart container TypeDB di tengah test.

# Grill Gate

- [x] Konvensi id: **custom prefix** (`SVC-*`, `F-*`, `A-*`, `CVE-*` — sudah dipakai `kit-ontology.md`).
      Keputusan user 2026-08-21 — stabil, ⊥ tergantung API eksternal, gampang dibaca manusia. ⊥ perlu
      perubahan; `kit-ontology.md` §Catatan sudah konsisten dgn ini.
- [x] Schema secrets/compliance: **tunda**. Keputusan user 2026-08-21 — YAGNI, belum ada requirement
      konkret; TypeQL `define` gampang di-extend nanti (attribute/owns tambahan), ⊥ perlu migrasi berat.
