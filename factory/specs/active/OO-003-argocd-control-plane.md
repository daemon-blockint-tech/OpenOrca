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

1. `src/argocd/client.ts` — Bearer token, typed wrapper utk: get app, resource-tree, sync, rollback, patch syncPolicy, resource/actions/v2.
2. Tool destruktif (`argocd_sync`, `argocd_rollback`, `rollout_recall`, `rollout_promote`) di-flag `interruptOn` & test membuktikan eksekusi tertahan sampai resume (V1).
3. `argocd_rollback` menolak app ber-Rollout dgn pesan arahan ke `rollout_recall` (V4).
4. ∀ tool destruktif menulis `agent-action` via `ontology_write` setelah sukses (V7) — depend OO-002.
5. `smoke-recall.mjs`: app demo + Rollout di kind → recall → assert `status.abort=true` → promote-full → assert Healthy.

# Constraints

- ⊥ kubeconfig/direct CR write (V8) — semua via API server REST.
- ⊥ SDK ArgoCD pihak ketiga; fetch + tipe tangan sendiri dari swagger.

# Review Notes

Risk high: tool ini menyentuh cluster. Review wajib cek: HITL tidak bisa di-bypass, RBAC scoped ke project openorca saja.

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
