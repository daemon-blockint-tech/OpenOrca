## Gaps & corrections

**1. TypeDB from TypeScript — path exists but is HTTP-only, with hard limits nobody flagged as a design constraint**
- Confirmed: the typedb repo contains zero Node.js/TS code; the only TS-viable path in-repo is the HTTP v1 API (`typedb/server/service/http/typedb_service.rs`). The gRPC path requires generating a client from the external `typedb-protocol` repo (tag 3.12.0) — feasible from TS via tonic-compatible protobuf, but no report confirms an official TS driver exists (the official `typedb-driver` repo is not in the checkout; verify whether its 3.x line ships a Node driver before committing to gRPC).
- Load-bearing consequence missing from all reports: the HTTP path caps results at 10,000 answers per query (`DEFAULT_ANSWER_COUNT_LIMIT_HTTP`, confirmed at `typedb/server/service/http/message/query/mod.rs:69`) with `206 Partial Content` on truncation, and does not stream. A Detect→Learn context graph queried by deepagents tools must paginate/aggregate in TypeQL or the agent silently sees partial data. Also: HTTP transaction IDs are process-local and tokens die on server restart — the TS client needs re-signin + retry logic (`AUT3`).
- Recommendation the reports never make: the deepagents integration point is a plain LangChain `tool()` wrapping HTTP `POST /v1/query` — the drivers report describes the endpoints but no report connects them to `CreateDeepAgentParams.tools`.

**2. Recall + roll-forward call chain — pinned for ArgoCD, but the ArgoCD↔Rollouts composition is the missing piece**
- ArgoCD-only recall is fully pinned (disable autosync → `Rollback` RPC or set `.operation` → later restore `spec.source.targetRevision`).
- Rollouts-only recall is fully pinned (`PATCH {"status":{"abort":true}}`, retry = `abort:false`).
- **Missing**: when ArgoCD manages a Rollout (the OpenOrca fleet case), the correct external-agent call is neither of those directly — it's `ApplicationService.RunResourceActionV2` invoking the Lua actions shipped in argo-cd. Verified in repo: `argo-cd/resource_customizations/argoproj.io/Rollout/actions/{abort,promote-full,retry,resume,restart,pause,skip-current-step}`; `abort/action.lua` is literally `obj.status.abort = true`. So the OpenOrca recall chain is: `POST /api/v1/applications/{app}/resource/actions/v2` with action `abort` (recall) / `promote-full` (roll forward), RBAC action `action`. No report states this, and the rollouts report only says the actions "live in Argo CD" without the path or RPC.
- Also unstated: aborting a Rollout leaves it `Degraded`, which ArgoCD health will report as degraded app — the Validate/Resolve loop must expect that, not treat it as a new incident.

**3. Contradiction between the two deepagents reports (verified against source)**
- `deepagents:capabilities` claims the browser entrypoint excludes `LangSmithSandbox`. Wrong: `deepagentsjs/libs/deepagents/src/browser.ts:167` exports `LangSmithSandbox`. The `deepagents:core` exclusion list (`createSettings`, `listSkills`, `createAgentMemoryMiddleware`, `FilesystemBackend`, `LocalShellBackend`) matches the file header comment exactly. Trust core here.
- Minor, resolved: core says StateBackend writes via `filesUpdate` in Commands; capabilities says zero-arg mode uses `__pregel_send`. Source (`backends/state.ts:45,90-127`) shows both are true — `__pregel_send` in zero-arg mode, `filesUpdate` in legacy mode. Not a real conflict, but core's phrasing describes the deprecated path.

**4. Load-bearing claims lacking file paths (all now resolved or confirmed)**
- "Argo CD integration is entirely convention-side... see docs/FAQ.md" (rollouts report) — the actual paths are `argo-cd/resource_customizations/argoproj.io/Rollout/health.lua` and `.../actions/discovery.lua` (verified present).
- Rollback autosync refusal confirmed at `argo-cd/server/application/application.go:2283-2284` (`FailedPrecondition`).
- The drivers report's "practical JS/TS path is HTTP v1" claim carried no route file; it's `typedb/server/service/http/typedb_service.rs` (confirmed).

**5. Missing entirely for the product loop**
- No report covers how a deepagents TS process authenticates to the Kubernetes API or ArgoCD API server end-to-end. The pieces exist separately (argocd:api's machine-auth section: `accounts.<name>: apiKey` in `argocd-cm` + `POST /api/v1/account/<name>/token`), but the Remediate agent's tool needs either that token flow or direct CR writes via a kubeconfig — pick one; the reports never do. Direct CR writes bypass ArgoCD RBAC/audit, which matters for a security product.
- No report covers the Detect→OpenOrca push channel from ArgoCD. The hook is there — notifications `service.webhook.<name>` (argocd:api) — but nobody maps it to the loop (e.g. `on-health-degraded` trigger → OpenOrca webhook → spawn DeepAgent). State it as the wiring or the Detect stage has no eventing.
