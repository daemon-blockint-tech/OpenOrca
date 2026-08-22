# kit-fleet — topologi ApplicationSet + kontrol ArgoCD

Cites: SPEC §V4–V6, §V8, §V10. Referensi: `context/refs/research/argocd_architecture.md`, `argocd_api.md`, `argocd_sync-rollback.md`, `rollouts_strategies.md`, `gaps.md`.

## Topologi

1 fleet repo (git) `fleet/` berisi 1 direktori per service per env. ApplicationSet generator `git directories` × label cluster → tepat 1 `Application` per service (V10). Tiap direktori berisi manifest service + `Rollout` (bukan Deployment) utk workload yang butuh recall/canary.

```
fleet-repo/
└── envs/
    └── prod/
        ├── payments/        # kustomize/helm + Rollout
        ├── checkout/
        └── ...
```

## AppProject

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: openorca
  namespace: argocd
spec:
  description: OpenOrca-managed fleet
  sourceRepos: ["https://github.com/daemon-blockint-tech/openorca-fleet.git"]
  destinations:
    - server: "*"
      namespace: "svc-*"
  clusterResourceWhitelist: []          # namespace-scoped only
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
```

## ApplicationSet

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: openorca-fleet
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - matrix:
        generators:
          - clusters:
              selector:
                matchLabels: { openorca.io/fleet: "true" }
          - git:
              repoURL: https://github.com/daemon-blockint-tech/openorca-fleet.git
              revision: main
              directories: [{ path: "envs/prod/*" }]
  template:
    metadata:
      name: "{{.path.basename}}-{{.name}}"
      labels:
        openorca.io/managed: "true"
        openorca.io/service: "{{.path.basename}}"
      annotations:
        notifications.argoproj.io/subscribe.on-health-degraded.openorca: ""
        notifications.argoproj.io/subscribe.on-deployed.openorca: ""
    spec:
      project: openorca
      source:
        repoURL: https://github.com/daemon-blockint-tech/openorca-fleet.git
        targetRevision: main
        path: "{{.path.path}}"
      destination:
        server: "{{.server}}"
        namespace: "svc-{{.path.basename}}"
      syncPolicy:
        automated: { prune: true, selfHeal: true }
        syncOptions: [CreateNamespace=true, ServerSideApply=true]
        retry:
          limit: 5
          backoff: { duration: 5s, factor: 2, maxDuration: 3m }
```

- Label `openorca.io/service` = join key ke entity `service.id` di graph.
- `Generate` RPC (`POST /api/v1/applicationsets/generate`) = dry-run render — dipakai validasi topologi sebelum apply.
- Per-app override lewat param generator, ⊥ `Application.Patch` (appset controller menimpa balik).

## Machine account + RBAC (V8)

```yaml
# argocd-cm
data:
  accounts.openorca: apiKey
```

```csv
# argocd-rbac-cm → policy.csv
# CATATAN (review OO-003, live-terverifikasi 2026-08-22): PatchResource & RunResourceActionV2
# mengecek RBAC dgn action BENTUK SUBRESOURCE, bukan verb polos:
#   PatchResource        → applications, update/<group>/<kind>/<name>
#   RunResourceActionV2  → applications, action/<group>/<kind>/<action-name>
# Baris `update`/`action` polos TIDAK match bentuk itu → 403 permission denied
# (log argocd-server: "user tried to action/argoproj.io/Rollout/promote-full ...").
p, openorca, applications, get,      openorca/*, allow
p, openorca, applications, sync,     openorca/*, allow
p, openorca, applications, action,   openorca/*, allow
p, openorca, applications, rollback, openorca/*, allow
p, openorca, applications, update,   openorca/*, allow
p, openorca, applications, create,   openorca/*, allow
# subresource forms — wajib untuk rollout_recall/promote (action/v2) & patch managed resource:
p, openorca, applications, update/argoproj.io/*/*/*, openorca/*, allow
p, openorca, applications, action/argoproj.io/*/*,   openorca/*, allow
```

Token: `POST /api/v1/account/openorca/token` → simpan `ARGOCD_TOKEN`. Verifikasi murah: `GET /api/v1/account/can-i/applications/sync/openorca%2F*`.

## Notifications → OpenOrca (eventing Detect)

```yaml
# argocd-notifications-cm
data:
  service.webhook.openorca: |
    url: https://openorca.example.com/openorca/webhook
    headers:
      - name: X-OpenOrca-Secret
        value: $openorca-webhook-secret
  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      send: [openorca-event]
  trigger.on-deployed: |
    - when: app.status.operationState.phase == 'Succeeded' and app.status.health.status == 'Healthy'
      send: [openorca-event]
  template.openorca-event: |
    webhook:
      openorca:
        method: POST
        body: |
          {"app": "{{.app.metadata.name}}",
           "service": "{{index .app.metadata.labels "openorca.io/service"}}",
           "health": "{{.app.status.health.status}}",
           "phase": "{{.app.status.operationState.phase}}",
           "revision": "{{.app.status.sync.revision}}"}
```

Catatan V6: event Degraded utk app yang baru di-recall = expected — receiver cek `status.abort` Rollout (via `argocd_app_status`) sebelum spawn agent incident.

## Call chain recall / roll-forward (verbatim, terverifikasi ke source)

```
# RECALL (app ber-Rollout) — V4:
POST /api/v1/applications/{app}/resource/actions/v2
  {action: "abort", resourceName, namespace, group: "argoproj.io", version: "v1alpha1", kind: "Rollout"}
  # Lua argo-cd resource_customizations/argoproj.io/Rollout/actions/abort: obj.status.abort = true

# RECALL (app biasa) — V5:
PATCH app: spec.syncPolicy.automated.enabled=false
POST /api/v1/applications/{app}/rollback {id: <status.history id>}

# ROLL FORWARD:
git push fix → autosync jalan; Rollout ter-abort → action "promote-full" | "retry"

# GATE/SOAK:
Rollout canary steps: setWeight → pause {duration} → analysis (AnalysisTemplate Prometheus)
  failureLimit default 0 = kegagalan pertama abort — set sadar per metric
```

## Acceptance criteria

1. Apply AppProject+ApplicationSet di kind → N Application muncul, semua label `openorca.io/managed`, sync Healthy (V10).
2. Hapus direktori service di fleet repo → Application ter-prune otomatis.
3. Push image rusak → analysis gagal → Rollout auto-abort → notifications POST ke webhook OpenOrca ≤ 1m.
4. Recall via actions/v2 abort → traffic balik ke stable; app Degraded; ⊥ incident baru dibuka (V6).
5. Token openorca bisa sync/action di project openorca; `can-i` utk project lain → deny (V8).
