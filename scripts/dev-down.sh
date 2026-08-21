#!/usr/bin/env bash
# Tear down the OpenOrca dev environment completely (AC6: bersih total).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a
source versions.env
set +a

echo "==> tearing down kind cluster: $KIND_CLUSTER_NAME"
kind delete cluster --name "$KIND_CLUSTER_NAME" 2>/dev/null || echo "    (already gone)"

echo "==> tearing down data plane (TypeDB + Postgres)"
docker compose --env-file versions.env down -v

echo "==> done"
