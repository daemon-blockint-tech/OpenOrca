---
id: OO-001
title: Dev infra — TypeDB + kind + ArgoCD + Rollouts bootstrap
agent: claude
risk: low
grill: pending
verification:
  - "docker compose up -d && curl -sf http://localhost:8000/health"
  - "kind get clusters | grep openorca"
  - "kubectl -n argocd get deploy argocd-server argocd-repo-server argocd-application-controller"
  - "kubectl -n argo-rollouts get deploy argo-rollouts"
---

# Context

SPEC §T1. Fondasi lokal utk semua task lain. TypeDB v3 via docker (port 1729 gRPC, 8000 HTTP, kredensial default `admin/password`); cluster kind `openorca`; ArgoCD v3 + Argo Rollouts install manifest resmi. Referensi: `context/refs/research/typedb_drivers.md` (port/auth), `argocd_architecture.md`.

# Acceptance Criteria

1. `scripts/dev-up.sh` idempotent: compose TypeDB + kind create + install ArgoCD + Rollouts; jalan ulang tanpa error.
2. `curl http://localhost:8000/health` → 204.
3. `POST /v1/signin` dgn `admin/password` → token.
4. ArgoCD API server reachable via port-forward; `argocd version` sukses.
5. `scripts/dev-down.sh` bersih total.

# Constraints

- ⊥ helm chart custom; manifest resmi upstream saja.
- Versi di-pin di satu file `versions.env`.
- ⊥ expose port ke luar localhost.

# Review Notes

Cek idempotensi (jalankan dev-up 2x) & pin versi.

# Grill Gate

- [ ] Cluster target dev: kind cukup, atau harus k3d/minikube/cluster existing? (pemilik: user)
- [ ] TypeDB: ganti password default admin di dev, atau biarkan? (pemilik: user)
