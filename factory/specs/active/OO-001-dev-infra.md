---
id: OO-001
title: Dev infra — TypeDB + kind + ArgoCD + Rollouts bootstrap
agent: claude
risk: low
grill: completed
verification:
  - "docker compose --env-file versions.env up -d && curl -s -o /dev/null -w '%{http_code}' http://localhost:8729/health | grep -qx 204"
  - "pg_isready -h localhost -p 5433 -U openorca"
  - "kind get clusters | grep openorca"
  - "kubectl -n argocd get deploy argocd-server argocd-repo-server"
  - "kubectl -n argocd get statefulset argocd-application-controller"
  - "kubectl -n argo-rollouts get deploy argo-rollouts"
---

# Context

SPEC §T1. Fondasi lokal utk semua task lain. TypeDB v3 via docker (host port 1729 gRPC, host port 8729 → container 8000 HTTP — bergeser dari 8000 krn bentrok layanan lokal lain di mesin dev, SPEC §B B3; kredensial default `admin/password`); Postgres via docker (host port 5433 → container 5432, checkpointer LangGraph — V19; host port bergeser dari 5432 krn bentrok native Postgres di mesin dev — SPEC §B B2); cluster `kind` (V-riset 2026-08-21, lihat Grill Gate); ArgoCD v3 + Argo Rollouts install manifest resmi. Referensi: `context/refs/research/typedb_drivers.md` (port/auth), `argocd_architecture.md`.

# Acceptance Criteria

1. `scripts/dev-up.sh` idempotent: compose TypeDB+Postgres + kind create + install ArgoCD + Rollouts; jalan ulang tanpa error.
2. `curl http://localhost:8729/health` → **204 persis** (bukan cuma 2xx — lihat SPEC §B B3).
3. `POST /v1/signin` dgn `admin/password` → token.
4. `pg_isready` sukses; `psql` bisa connect dgn kredensial `versions.env`/compose.
5. ArgoCD API server reachable via port-forward; `argocd version` sukses.
6. `scripts/dev-down.sh` bersih total.

# Constraints

- ⊥ helm chart custom; manifest resmi upstream saja.
- Versi di-pin di satu file `versions.env`.
- ⊥ expose port ke luar localhost.

# Review Notes

Cek idempotensi (jalankan dev-up 2x) & pin versi.

# Grill Gate

- [x] Cluster target dev: **kind**. Resolved via riset 2026-08-21 (workflow terpisah, sumber bertanggal):
      satu-satunya kandidat yang lolos 2 filter keras — (a) 2+ cluster murah utk uji ApplicationSet
      `clusters` generator (kind/k3d ~0.5GB idle/cluster vs minikube 1.5-2GB/cluster via VM driver), (b)
      pre-installed di GitHub Actions ubuntu runner (kind & minikube ya, k3d ⊥) → dev & CI pakai tool
      identik. kind menang atas k3d krn: dokumentasi ArgoCD sendiri default ke `kind create cluster`, dan
      kind = subproject resmi kubernetes-sigs (dipakai project Kubernetes sendiri utk conformance test).
      Rancher Desktop & Docker Desktop k8s gagal keras (1 cluster per instance, GUI-only ⊥ CI headless).
- [x] TypeDB: **biarkan default** (`admin/password`). Keputusan user 2026-08-21 — dev-only, terikat
      localhost (`docker-compose.yml`), di belakang Docker; ganti password nambah friksi tanpa nilai
      keamanan nyata di lingkungan dev ini. Re-evaluasi kalau TypeDB pernah di-expose di luar localhost.
