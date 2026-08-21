# kit-agent-tools — kontrak tools deepagents OpenOrca

Cites: SPEC §V1–V5, §V7–V9. Referensi: `context/refs/research/deepagents_core.md`, `deepagents_capabilities.md`, `argocd_api.md`, `gaps.md`.

∀ tool = LangChain `tool()` biasa → masuk `CreateDeepAgentParams.tools`. Nama ∉ builtin (V9). ∀ tool destruktif di-flag `interruptOn` (V1) & menulis `agent-action` ke graph setelah eksekusi (V7).

## Matrix

```
tool              | arah    | HITL | audit V7 | backend
ontology_query    | read    | ⊥    | ⊥        | TypeDB POST /v1/query (read, one-shot)
ontology_write    | write   | ⊥    | self     | TypeDB POST /v1/query (write, commit:true)
argocd_app_status | read    | ⊥    | ⊥        | GET /applications/{app} + /resource-tree
fleet_list        | read    | ⊥    | ⊥        | GET /applications?selector=openorca.io/managed=true
argocd_sync       | destruk | !    | !        | POST /applications/{app}/sync
argocd_rollback   | destruk | !    | !        | urutan V5 (3 call)
rollout_recall    | destruk | !    | !        | POST /applications/{app}/resource/actions/v2 action=abort
rollout_promote   | destruk | !    | !        | action=promote-full
```

## Kontrak per-tool

### ontology_query
- args: `{ query: string }` — TypeQL read pipeline.
- Behavior: signin lazy → `POST /v1/query`. Response `206` | `warning` truncation → **throw** pesan: `"hasil terpotong di 10k — tulis ulang query dgn reduce/limit/offset"` (V2). ⊥ return parsial.
- `AUT3`/401 → re-signin 1x → retry → gagal: throw (V3).
- return: `answers[]` JSON (`conceptRows` | `conceptDocuments`).

### ontology_write
- args: `{ query: string }` — insert/update/put/delete.
- Behavior: one-shot `commit: true` (auto-commit write). Error annotation TypeDB → teruskan verbatim ke agent (query salah = feedback berguna).
- Audit: tool ini SARANA audit — pemanggil wajib pola `insert $a isa agent-action ...` utk aksi non-graph.

### argocd_app_status
- args: `{ app: string }`.
- return: `{ syncStatus, healthStatus, operationPhase, revision, rolloutPhase?, rolloutAborted? }` — ringkas, bukan dump CR penuh (hemat konteks; deepagents evict >20k token).
- Wajib ekspos `rolloutAborted` supaya agent bisa menerapkan V6 (Degraded+abort = expected).

### argocd_sync
- args: `{ app: string, revision?: string }`. HITL !.
- `POST .../sync`; **async by design** → poll `operationState.phase` sampai terminal (timeout 10m) → return phase + message.

### argocd_rollback
- args: `{ app: string, historyId: number }`. HITL !.
- Precondition: app ⊥ ber-Rollout (kalau ada Rollout → tolak, arahkan `rollout_recall`) (V4).
- Urutan (V5): `PATCH spec.syncPolicy.automated.enabled=false` → `POST .../rollback {id}` → poll terminal → return. Re-enable autosync = keputusan terpisah (agent mengusulkan, HITL lagi).
- `historyId` dari `status.history`; ingat cap 10 — id hilang → beri tahu agent pakai `argocd_sync` + revision eksplisit.

### rollout_recall
- args: `{ app: string, resourceName: string, namespace: string }`. HITL !.
- `POST .../resource/actions/v2` body: `{ action: "abort", resourceName, namespace, group: "argoproj.io", version: "v1alpha1", kind: "Rollout" }`.
- Hasil: Rollout → Degraded + `status.abort=true` = SUKSES recall (V6). return `{ recalled: true, phase: "Degraded" }`.

### rollout_promote
- args: sama dgn recall, `action: "promote-full"`. HITL !.

### fleet_list
- args: `{ selector?: string }`.
- return: `[{ app, service, cluster, syncStatus, healthStatus }]`.

## Wiring deepagents

Model diambil dari registry multi-provider (`context/kits/kit-models.md`), ⊥ hardcode string di sini (V17).

```ts
const agent = createDeepAgent({
  model: resolveModel("anthropic", "claude-sonnet-4-6"),   // ganti provider = ganti argumen, lihat kit-models
  tools: [ontologyQuery, ontologyWrite, argocdAppStatus, fleetList,
          argocdSync, argocdRollback, rolloutRecall, rolloutPromote],
  interruptOn: {                                   // V1 — human in the lead
    argocd_sync: true, argocd_rollback: true,
    rollout_recall: true, rollout_promote: true,
  },
  checkpointer,                                    // wajib utk interrupt/resume
  subagents: [
    { name: "code-hunter",   description: "scan source repo utk vuln", tools: [...], /* sandbox backend */ },
    { name: "config-hunter", description: "scan deployment/manifest",  tools: [ontologyQuery, argocdAppStatus] },
    { name: "triager",       description: "nilai exploitability via graph", tools: [ontologyQuery, ontologyWrite] },
  ],
});
```

- Hunter pakai sandbox backend (`LocalShellBackend` dev / `BaseSandbox` impl prod) → `execute` builtin utk clone+scan; ⊥ tool clone custom.
- Permissions + backend exec → wajib `CompositeBackend` scoping (deepagents throw kalau tidak).
- Memory lintas-run: `StoreBackend` route `"/memories/"` + `memory:` AGENTS.md.

## Acceptance criteria

1. `createDeepAgent` dgn 8 tools ⊥ throw `TOOL_NAME_COLLISION` (V9).
2. Query >10k rows → `ontology_query` throw pesan reduce/limit; ⊥ return parsial (V2).
3. Restart TypeDB di tengah sesi → tool berikutnya sukses via re-signin (V3); matikan TypeDB → error surfaced, ⊥ retry loop.
4. `rollout_recall` pada Rollout live → `status.abort=true` di cluster + row `agent-action` action-kind `recall` di graph (V4, V7).
5. `argocd_rollback` pada app autosync-on → autosync off dulu → rollback sukses (⊥ FailedPrecondition bocor) (V5).
6. Panggil `argocd_sync` → eksekusi TERTAHAN di interrupt sampai resume manusia (V1) — uji via checkpointer + `Command` resume.
