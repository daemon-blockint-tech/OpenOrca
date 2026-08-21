#!/usr/bin/env bash
# OpenOrca dev environment bootstrap — idempotent.
# Brings up: TypeDB + Postgres (docker compose), a kind cluster, Argo CD, Argo Rollouts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a
source versions.env
set +a

echo "==> [1/4] data plane: TypeDB + Postgres"
# --wait blocks until both services' own HEALTHCHECKs (docker-compose.yml) report healthy —
# real Docker-native health tracking, not a hand-rolled host-side polling loop. The old
# curl -sf approach here is exactly what produced SPEC §B B3 (false pass from an unrelated
# service on the same port); the compose healthcheck greps for TypeDB's literal 204, and
# Docker's own health state machine is what --wait blocks on, so this can't repeat.
docker compose --env-file versions.env up -d --wait

echo "==> [2/4] kind cluster: $KIND_CLUSTER_NAME"
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER_NAME"; then
  echo "    cluster already exists, skipping create"
else
  kind create cluster --name "$KIND_CLUSTER_NAME"
fi
kubectl config use-context "kind-$KIND_CLUSTER_NAME" >/dev/null

echo "==> [3/4] Argo CD $ARGOCD_VERSION"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# --server-side: plain (client-side) apply writes the full previous object into the
# kubectl.kubernetes.io/last-applied-configuration annotation, which is capped at 262144 bytes
# by the API server — Argo CD's applicationsets.argoproj.io CRD alone exceeds that (SPEC §B B4).
# Server-side apply tracks ownership via managedFields instead, with no such limit.
# --force-conflicts: safe to always pass here — a fresh install has no conflicting field owners,
# and a retry after a partial client-side apply (like the one that produced B4) does.
kubectl apply --server-side --force-conflicts -n argocd \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml" >/dev/null
kubectl -n argocd rollout status deploy/argocd-server --timeout=240s
kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=240s
# argocd-application-controller ships as a StatefulSet, not a Deployment (verified against
# the v3.5.1 manifest — see SPEC.md §B B1).
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=240s

echo "==> [4/4] Argo Rollouts $ARGO_ROLLOUTS_VERSION"
kubectl create namespace argo-rollouts --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# --server-side for the same reason as Argo CD above — its CRDs (AnalysisTemplate etc.) are
# large enough to risk the same 262144-byte annotation cap.
kubectl apply --server-side --force-conflicts -n argo-rollouts \
  -f "https://github.com/argoproj/argo-rollouts/releases/download/${ARGO_ROLLOUTS_VERSION}/install.yaml" >/dev/null
kubectl -n argo-rollouts rollout status deploy/argo-rollouts --timeout=240s

if ! command -v argocd >/dev/null 2>&1; then
  echo "==> argocd CLI not found — installing via Homebrew"
  brew install argocd
fi

cat <<'EOF'
==> done.

Next:
  kubectl -n argocd port-forward svc/argocd-server 8880:443 &
  argocd login localhost:8880 --username admin --insecure \
    --password "$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
EOF
