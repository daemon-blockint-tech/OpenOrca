#!/usr/bin/env bash
# OpenOrca dev environment bootstrap — idempotent.
# Brings up: TypeDB + Postgres (docker compose), a kind cluster, Argo CD, Argo Rollouts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a
source versions.env
set +a

wait_for() {
  local desc="$1" tries="$2"
  shift 2
  for ((i = 1; i <= tries; i++)); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "==> ERROR: $desc did not become ready in time" >&2
  exit 1
}

echo "==> [1/4] data plane: TypeDB + Postgres"
docker compose --env-file versions.env up -d
wait_for "TypeDB" 30 curl -sf http://localhost:8000/health
wait_for "Postgres" 30 pg_isready -h localhost -p 5432 -U openorca

echo "==> [2/4] kind cluster: $KIND_CLUSTER_NAME"
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER_NAME"; then
  echo "    cluster already exists, skipping create"
else
  kind create cluster --name "$KIND_CLUSTER_NAME"
fi
kubectl config use-context "kind-$KIND_CLUSTER_NAME" >/dev/null

echo "==> [3/4] Argo CD $ARGOCD_VERSION"
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -n argocd -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml" >/dev/null
kubectl -n argocd rollout status deploy/argocd-server --timeout=240s
kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=240s
# argocd-application-controller ships as a StatefulSet, not a Deployment (verified against
# the v3.5.1 manifest — see SPEC.md §B B1).
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=240s

echo "==> [4/4] Argo Rollouts $ARGO_ROLLOUTS_VERSION"
kubectl create namespace argo-rollouts --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -n argo-rollouts -f "https://github.com/argoproj/argo-rollouts/releases/download/${ARGO_ROLLOUTS_VERSION}/install.yaml" >/dev/null
kubectl -n argo-rollouts rollout status deploy/argo-rollouts --timeout=240s

if ! command -v argocd >/dev/null 2>&1; then
  echo "==> argocd CLI not found — installing via Homebrew"
  brew install argocd
fi

cat <<'EOF'
==> done.

Next:
  kubectl -n argocd port-forward svc/argocd-server 8080:443 &
  argocd login localhost:8080 --username admin --insecure \
    --password "$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
EOF
