---
id: OO-003
title: ArgoCD control plane — machine account + client + tools argocd_*/rollout_* (HITL)
agent: claude
risk: high
grill: completed
verification:
  - "npm test -- argocd"
  - "node scripts/smoke-recall.mjs"
---

# Context

SPEC §T5–T6, invariant V1 V4 V5 V8 V9. Machine account + RBAC verbatim dari `context/kits/kit-fleet.md` §Machine account. Kontrak tool + urutan call: `context/kits/kit-agent-tools.md`. Call chain recall/rollback TERVERIFIKASI ke source (`context/refs/research/gaps.md` butir 2) — ⊥ improvisasi jalur lain.

# Acceptance Criteria

`kit-agent-tools.md` butir 4–6 + `kit-fleet.md` butir 5. Tambahan:

1. `packages/argocd/src/client.ts` — Bearer token, typed wrapper utk: get app, resource-tree, appStatus, sync, rollback, setAutosync, runResourceAction. **✓ 7/7 unit test + terbukti live (appStatus thd ArgoCD nyata via machine token).**
2. Tool destruktif (`argocd_sync`, `argocd_rollback`, `rollout_recall`, `rollout_promote`) di-flag `interruptOn` (V1). **✓ `INTERRUPT_ON` di-assert memuat TEPAT 4 tool destruktif, ⊥ menyentuh tool read-only.**
3. `argocd_rollback` menolak app ber-Rollout dgn pesan arahan ke `rollout_recall` (V4). **✓ test menolak + V5 (autosync off SEBELUM rollback, urutan call di-assert, dibiarkan disabled).**
4. ∀ tool destruktif menulis `agent-action` via `ontology_write` setelah sukses (V7). **✓ test audit sukses + test kegagalan audit ⊥ menutupi aksi fleet yg berhasil (di-surface sbg `auditError`).**
5. `smoke-recall.mjs`: app demo + Rollout di kind → recall → assert aborted → promote-full → assert Healthy. **✓ LULUS LIVE 2026-08-22: v1 Healthy → canary v2 (Suspended) → abort → Degraded (V6) → retry+promote-full → Healthy, exit 0.**

# Constraints

- ⊥ kubeconfig/direct CR write (V8) — semua via API server REST.
- ⊥ SDK ArgoCD pihak ketiga; fetch + tipe tangan sendiri dari swagger.

# Review Notes

Risk high: tool ini menyentuh cluster. Review wajib cek: HITL tidak bisa di-bypass, RBAC scoped ke project openorca saja.

**Bukti RBAC (live 2026-08-22):** machine account `openorca` (apiKey) + policy.csv 5 baris scoped `openorca/*`.
`can-i applications/sync/openorca/*` → **yes**; `can-i applications/sync/default/*` → **no**. Machine account
sengaja ⊥ punya `applications,create` — pembuatan Application adalah tugas ApplicationSet (kit-fleet), bukan aksi tool.
Karena itu langkah setup di `smoke-recall.mjs` (create app, bump image) dijalankan dgn token admin (operator-level),
sedangkan jalur yg dipakai tools tetap token machine ter-scope.

**Bukti HITL:** `INTERRUPT_ON` di-export dari `@openorca/agents` & di-assert berisi tepat 4 tool destruktif.
Gate sesungguhnya ditegakkan deepagents saat `createDeepAgent({interruptOn})` + checkpointer — test membuktikan
wiring & isi flag, bukan mem-bypass-nya.

# Grill Gate

- [x] Fleet repo: **https://github.com/daemon-blockint-tech/openorca-fleet** (dibuat 2026-08-21, README
      seed sudah push). `kit-fleet.md` placeholder `git.example.com` sudah diganti URL nyata di semua
      occurrence (AppProject `sourceRepos`, ApplicationSet `repoURL` ×2). Manifest aktual (envs/prod/*)
      diisi task T10.
- [x] Re-enable autosync pasca-rollback: **selalu manual**. Keputusan user 2026-08-21 — sejalan V1
      human-in-the-lead; engineer eksplisit nyalakan lagi setelah yakin rollback stabil, ⊥ ada window
      auto-rollforward tak terduga. Implikasi: `argocd_rollback` tool (kit-agent-tools.md) ⊥ pernah
      auto-re-enable `spec.syncPolicy.automated.enabled` — itu aksi terpisah, HITL lagi kalau lewat agent.
- [x] Demo app: **repo baru** — https://github.com/daemon-blockint-tech/openorca-demo-app (dibuat
      2026-08-21, README seed sudah push). Isolated, aman di-rusak sengaja utk uji recall/rollforward
      (SPEC T12), ⊥ ganggu app nyata. Konten (health endpoint + Rollout canary manifest) diisi T10/T12.
