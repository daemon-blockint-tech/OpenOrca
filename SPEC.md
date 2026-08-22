# SPEC — OpenOrca

## §G

Vulnerability operations open-source: loop Detect→Validate→Remediate→Resolve→Learn. Agent runtime = deepagentsjs, context graph = TypeDB v3, fleet deploy/recall = ArgoCD+Rollouts. Human in the lead ∀ aksi kritis.

## §C

- Stack pinned: `deepagents` v1.13 (TS/Node) | TypeDB v3 via HTTP v1 | ArgoCD v3 + Argo Rollouts | Kubernetes.
- Runtime TS/Node. ⊥ Python.
- Multi-model, multi-provider: OpenAI, Anthropic, AWS Bedrock, Ollama, DeepSeek, Alibaba Tongyi, OpenRouter, LM Studio, HuggingFace. Registry tunggal `packages/agents/src/models/`, ⊥ hardcode provider di tools/pipeline. Detail: `context/kits/kit-models.md`.
- Checkpointer = `@langchain/langgraph-checkpoint-postgres` (self-hosted Postgres). Riset 2026-08-21: satu-satunya opsi yang tahan restart+multi-proses (V1) & direkomendasikan resmi LangGraph.js utk produksi; MemorySaver/SqliteSaver ⊥ cukup di luar single-instance dev.
- Dev cluster = `kind`. Riset 2026-08-21: satu-satunya yang lolos 2 filter keras — multi-cluster murah (topologi ApplicationSet §kit-fleet) & jalan di GitHub Actions ubuntu runner tanpa install tambahan; Rancher/Docker Desktop k8s gagal di multi-cluster, minikube 3-4x lebih berat per cluster.
- Sandbox hunter = self-hosted Docker+gVisor (default), Firecracker/microsandbox = upgrade path. Detail: `context/kits/kit-sandboxes.md`.
- TypeDB HTTP: cap 10k answers/query, token JWT volatile (mati saat restart), tx id process-local.
- Audit primer di TypeDB, ⊥ andalkan `status.history` ArgoCD (cap 10, selective sync tak tercatat).
- Sovereignty: ∀ context store (graph TypeDB, checkpointer, memory, factory audit) self-hosted; ⊥ SaaS eksternal utk context. Model provider = pilihan org (bisa self-hosted via string `"provider:model"`).
- Success = verified risk turun di software ter-deploy, fix cepat|andal|efisien; ⊥ panjang daftar finding.
- License Apache-2.0.
- Detail teknikal fondasi: `context/refs/research/` + kits di `context/kits/`.

## §I

```
api: POST {TYPEDB_URL}/v1/signin {username,password} → {token}
api: POST {TYPEDB_URL}/v1/query {query, commit?} → QueryAnswerResponse | 206 partial
api: POST {ARGOCD_URL}/api/v1/account/openorca/token → {token}
api: POST {ARGOCD_URL}/api/v1/applications/{app}/sync → Application
api: POST {ARGOCD_URL}/api/v1/applications/{app}/rollback {id} → Application
api: POST {ARGOCD_URL}/api/v1/applications/{app}/resource/actions/v2 {action: abort|promote-full|retry} → _
api: GET  {ARGOCD_URL}/api/v1/applications/{app}/resource-tree → tree
api: POST /openorca/webhook ← argocd notifications service.webhook.openorca
tools: ontology_query | ontology_write | argocd_app_status | argocd_sync | argocd_rollback | rollout_recall | rollout_promote | fleet_list
env: TYPEDB_URL ! ; TYPEDB_USER ! ; TYPEDB_PASS ! ; ARGOCD_URL ! ; ARGOCD_TOKEN ! ; OPENORCA_WEBHOOK_SECRET !
```

Kontrak penuh tools → `context/kits/kit-agent-tools.md`. Schema graph → `context/kits/kit-ontology.md`. Topologi fleet → `context/kits/kit-fleet.md`.

## §V

```
V1: ∀ aksi destruktif (sync|rollback|recall|promote) → HITL interrupt (interruptOn + checkpointer) sebelum eksekusi
V2: ontology_query hasil 206|10k cap → error eksplisit ke agent ("tambah reduce|limit"); ⊥ terima data parsial diam-diam
V3: TypeDB error AUT3 → re-signin 1x → retry; gagal lagi → surface, ⊥ loop
V4: recall app ber-Rollout → RunResourceActionV2 action=abort; ⊥ patch Rollout langsung; ⊥ Rollback RPC
V5: rollback app non-Rollout → urutan: autosync off → rollback {id} → re-enable; (RPC menolak FailedPrecondition kalau autosync on)
V6: Rollout phase=Degraded & status.abort=true → state recall expected; ⊥ buka incident baru
V7: ∀ finding|verdict|aksi agent → row di graph (relation `<kind>-action` sub `agent-action` / finding); audit trail lengkap di TypeDB
V8: ∀ akses ArgoCD → API server + token machine account (RBAC+audit); ⊥ direct CR write via kubeconfig
V9: nama tool custom ∉ BUILTIN_TOOL_NAMES deepagents (ls, read_file, write_file, edit_file, delete, glob, grep, execute, task, *_async_task)
V10: ∀ service ter-manage → tepat 1 Application, di-generate ApplicationSet openorca-fleet; ⊥ Application manual
V11: Hunt agents jalan hanya setelah Foundation hasilkan threat model + attack surface (gate sekuensial)
V12: finding → challenge oleh judge independen (SubAgent handoff, ⊥ warisi sesi hunter) sebelum route/report; refuted/lemah → downgrade|drop, ⊥ route
V13: ∀ Hunt agent = tools + permissions ter-scope per spesialisasi (least privilege; permissions MENGGANTIKAN parent)
V14: dedup deterministik via source→sink path (entry-point+sink); ⊥ semantic-similarity-only. Path sama → collapse; beda → distinct
V15: finding ber-verdict false-positive | state dismissed → run berikutnya suppress sebelum route; ⊥ re-surface dismissed
V16: coverage ⊥ diklaim dari 1 run | 1 model; butuh repeated runs + cross-model comparison (agentic = probabilistik)
V17: ∀ provider model → didaftar via `resolveModel` registry (kit-models); ⊥ instansiasi `Chat*` provider langsung di tools/pipeline/subagent
V18: ∀ hunter subagent (execute repo pihak ketiga) → sandbox ter-isolasi via `resolveSandbox` registry (kit-sandboxes); ⊥ LocalShellBackend / execute host tanpa isolasi
V19: checkpointer produksi = Postgres (self-hosted); MemorySaver/SqliteSaver ⊥ dipakai di luar single-instance dev
```

## §T

```
id|status|task|cites
T1|~|dev infra: TypeDB 3.x (docker) + kind + ArgoCD + Rollouts, script bootstrap — 5/6 AC live-terverifikasi (OO-001 active), AC6 (teardown) pending konfirmasi destruktif|I.env
T2|x|apply schema.tql + functions ke db openorca — DONE 2026-08-22, live: db `openorca`, blast(A) siklus A-B-C-A → {A,B,C} 0.028s; agent-action direfaktor jadi abstract relation (B5), query per-kind terstruktur terverifikasi|V7,kit-ontology
T3|.|lib client TypeDB HTTP (signin, retry AUT3, one-shot query, deteksi 206)|V2,V3,I.api
T4|.|tools ontology_query + ontology_write|V2,V7,V9,I.tools
T5|.|ArgoCD machine account openorca + RBAC + lib client REST|V8,I.api
T6|.|tools argocd_* + rollout_* dgn HITL|V1,V4,V5,V9,I.tools
T7|.|webhook receiver: notifications → spawn agent Detect|I.api,kit-fleet
T8|.|Hunt stage: subagents paralel per kelas vuln (authz, parsing, outbound, secrets, deps) + combination agent (exploit chain lintas komponen)|V9,V11,V13,kit-workflow
T9|.|Validate: fn blast + owner-of → route finding tervalidasi ke owner|V6,V12,kit-ontology,kit-workflow
T10|.|ApplicationSet openorca-fleet + AppProject + notifications config|V10,kit-fleet
T11|.|Learn: verdict + adjudikasi + remediation → graph; run berikutnya suppress dismissed|V7,V15,kit-ontology
T12|.|e2e drill: detect→recall→rollforward di demo app|V1,V4,V5,V6
T13|.|Foundation stage: map repo/deps/interfaces/auth/deploy → threat model + attack surface → graph|V7,V11,kit-workflow
T14|.|Challenge+dedup: judge independen (context-isolated) + dedup source→sink deterministik|V12,V14,kit-workflow,kit-ontology
T15|.|Correlate+report: collapse kelemahan terkait → unified finding (exploit-path, severity, cwe-id, remediation)|V14,kit-workflow,kit-ontology
T16|.|Cross-model harness: repeated runs + model comparison; lacak coverage/validation-rate/cost/runtime/refusal/dup-rate|V16,kit-workflow
T17|.|Shared engineer review surface: inspect evidence, add context, validasi severity, assign owner, approve remediasi|V1,V12,kit-workflow
T18|.|Scaffold monorepo (apps/api, apps/web, packages/{shared,ontology,argocd,agents}) per plan-project-structure|V9,plan-project-structure
T19|.|Model registry: resolveModel utk 9 provider (openai, anthropic, bedrock, ollama, deepseek, alibaba-tongyi, openrouter, lmstudio, huggingface)|V16,V17,kit-models
T20|.|Sandbox registry: DockerGvisorSandbox (default, hardened) + resolveSandbox; prototipe Firecracker/microsandbox|V13,V18,kit-sandboxes
```

## §B

```
id|date|cause|fix
B1|2026-08-21|OO-001 verification asumsi `argocd-application-controller` = Deployment; manifest resmi v3.5.1 = StatefulSet|-
B2|2026-08-22|compose Postgres bind host `5432` bentrok native Postgres (brew) di mesin dev|host port → 5433, container tetap 5432
B3|2026-08-22|(a) compose TypeDB bind host `8000` bentrok proses lokal lain; (b) `wait_for` pakai `curl -sf` (cek 2xx apa saja) → false-pass saat layanan lain balas 200 di `/health`|host port → 8729; health-check diperketat cek status 204 persis (TypeDB asli), ⊥ sekadar 2xx
B4|2026-08-22|`kubectl apply` client-side gagal krn CRD `applicationsets.argoproj.io` > limit annotation 262144 byte|`kubectl apply --server-side --force-conflicts` (ArgoCD + Rollouts, keduanya CRD besar)
B5|2026-08-22|desain awal `agent-action` = entity + `action-kind` enum string; target aksi cuma di `evidence` JSON mentah, ⊥ query-able terstruktur|refactor → `agent-action @abstract relation` + 7 subtype (pola type-theoretic relations, TypeDB Academy 11.2); terverifikasi live
B6|2026-08-22|insert relation pakai `$a (role: $x) isa T` → error WCP4 (TypeDB v3 wajib keyword `links` eksplisit)|`$a isa T, links (role: $x), has ...;` — terverifikasi live, semua contoh kit diperbaiki
B7|2026-08-22|hardening CIS docker-compose.yml (tmpfs `/etc/passwd` bikin file itu kosong; `CMD-SHELL` pakai dash yg ⊥ dukung `/dev/tcp`; digest pin awal ⊥ cocok image teruji)|entry `/etc/passwd` dihapus (redundan dgn `read_only:true`); healthcheck TypeDB pakai `CMD`+`bash -c` eksplisit (diverifikasi dash gagal, bash sukses); `TYPEDB_IMAGE`/`POSTGRES_IMAGE` di-pin ke digest yg SUDAH teruji jalan (bukan hash tak dikenal) — semua terverifikasi live pasca-hardening: container healthy, data survive, koneksi jalan
B5|2026-08-22|healthcheck TypeDB di compose pakai `CMD-SHELL` → dieksekusi via `/bin/sh` (dash) yang ⊥ dukung `/dev/tcp`; komentar salah klaim bash → healthcheck selalu gagal `Directory nonexistent`, `--wait` hang|test diganti `["CMD", "bash", "-c", ...]` eksplisit; ditemukan saat hardening CIS (cap_drop/read-only) memicu re-verify penuh
```
