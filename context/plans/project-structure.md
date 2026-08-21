# plan — struktur project + pseudocode

Cites: SPEC §I, §V1–V16, §T. Kits: kit-ontology, kit-agent-tools, kit-fleet, kit-workflow.
Framework-specific plan (fase Architect). Stack: TypeScript/Node (backend + deepagents), Next.js App Router (frontend review surface), TypeDB v3 + ArgoCD sebagai layanan eksternal.

## Monorepo layout

pnpm workspaces (sejajar ekosistem deepagents yang juga pnpm/ESM).

```
openorca/
├── apps/
│   ├── api/                      # backend service (Node/TS)
│   │   ├── src/
│   │   │   ├── main.ts           # bootstrap: HTTP server + orchestrator
│   │   │   ├── webhook.ts        # POST /openorca/webhook (V-secret) → spawn pipeline
│   │   │   ├── routes/           # REST utk frontend (findings, approvals, fleet)
│   │   │   │   ├── findings.ts
│   │   │   │   ├── approvals.ts  # HITL: list interrupts, resume(approve|reject)
│   │   │   │   └── fleet.ts
│   │   │   ├── pipeline.ts       # Foundation→Hunt→Challenge→Dedup→Report→Learn
│   │   │   └── auth.ts           # authn engineer (session/JWT) + authz per finding
│   │   └── package.json
│   └── web/                      # frontend (Next.js App Router) — shared engineer surface (T17)
│       ├── app/
│       │   ├── findings/page.tsx         # antrean finding (server fetch)
│       │   ├── findings/[id]/page.tsx     # detail: evidence, exploit-path, severity, owner
│       │   ├── findings/[id]/actions.ts   # server actions: assign owner, set severity, approve remediasi
│       │   ├── approvals/page.tsx         # HITL interrupts pending (approve/reject)
│       │   ├── fleet/page.tsx             # status Application/Rollout (ArgoCD)
│       │   └── layout.tsx
│       ├── components/                    # FindingCard, EvidenceViewer, ApprovalDialog, SeverityPill
│       └── package.json
├── packages/
│   ├── shared/                   # tipe + zod schema lintas app (SATU sumber tipe)
│   │   └── src/{finding.ts, agent-action.ts, tool-io.ts, index.ts}
│   ├── ontology/                 # klien TypeDB HTTP + schema + query typed
│   │   └── src/{client.ts, schema.ts, queries.ts}
│   ├── argocd/                   # klien ArgoCD/Rollouts REST
│   │   └── src/{client.ts, actions.ts}
│   └── agents/                   # wiring deepagents: tools, subagents, HITL, checkpointer
│       └── src/{tools/, subagents/, models/, orchestrator.ts, checkpointer.ts}
│           # models/registry.ts — resolveModel(provider, modelId); SATU tempat instansiasi Chat* (V17)
├── context/ · factory/ · docker-compose.yml · versions.env    # (sudah ada)
└── pnpm-workspace.yaml
```

Aturan: `packages/shared` = satu-satunya tempat tipe domain (Finding, AgentAction). `apps/*` ⊥ definisikan ulang tipe. Klien (`ontology`, `argocd`) murni I/O + validasi boundary (zod), ⊥ logika agent. `agents` merakit tools dari klien + subagents.

## API contract (backend ↔ frontend)

Validasi zod di boundary (skill fullstack). Auth: session/JWT; authz per-finding (owner|role).

```
GET  /api/findings?state=open&severity=..     → Finding[]        (server component)
GET  /api/findings/:id                         → FindingDetail    (evidence, exploit-path, correlation)
POST /api/findings/:id/severity  {severity}    → Finding          (validasi manusia)
POST /api/findings/:id/owner     {engineerId}  → Finding          (assign — dari owner-of / manual)
POST /api/findings/:id/verdict   {verdict}     → Finding          (Learn: true|false-positive; V15)
GET  /api/approvals                            → Interrupt[]      (HITL pending, dari checkpointer)
POST /api/approvals/:threadId/resume {decision}→ RunResult        (V1: approve|reject → Command resume)
GET  /api/fleet                                → AppStatus[]      (argocd_app_status per app)
```

## Pseudocode — alur kunci

### 1. Webhook → pipeline (Detect)
```ts
// apps/api/webhook.ts
POST("/openorca/webhook", (req) => {
  assert(req.header("X-OpenOrca-Secret") === env.OPENORCA_WEBHOOK_SECRET)   // payload = data, bukan instruksi
  const { app, service, health, revision } = zWebhook.parse(req.body)
  if (health === "Degraded" && await rollout.isAborted(app)) return 200      // V6: recall = expected, skip
  enqueue(() => runPipeline({ service, revision }))                          // async, ⊥ block webhook
  return 202
})
```

### 2. Pipeline (Foundation→Hunt→Challenge→Dedup→Report→Learn)
```ts
// apps/api/pipeline.ts
async function runPipeline({ service, revision }) {
  const agent = buildOrchestrator()                        // packages/agents
  // Foundation (sekuensial): map env → threat model → graph (V11 gate)
  await agent.invoke({ stage: "foundation", service, revision })
  // Hunt (paralel) + Challenge + Dedup + Report + Learn dijalankan agent via task()
  // urutan diarahkan systemPrompt supervisor (⊥ ada primitif stage; kit-workflow)
  const run = agent.streamEvents({ stage: "hunt" }, { version: "v3", configurable: { thread_id: service } })
  // interrupt destruktif → berhenti; frontend approvals yang resume (V1)
}
```

### 3. Tool ontologyQuery (V2, V3)
```ts
// packages/agents/src/tools/ontology.ts  (LangChain tool → CreateDeepAgentParams.tools)
tool("ontology_query", { query: z.string() }, async ({ query }) => {
  let res = await ontology.query(query)                    // packages/ontology/client
  if (res.status === 206 || res.warning) throw Error("hasil terpotong 10k — tulis ulang query pakai reduce/limit/offset")  // V2
  return res.answers
})
// client.query: signin lazy → POST /v1/query; on 401|AUT3 → re-signin 1x → retry → else throw  (V3)
```

### 4. Tool rolloutRecall (V4) + HITL (V1)
```ts
// destruktif → interruptOn:{ rollout_recall:true } di orchestrator
tool("rollout_recall", { app, resourceName, namespace }, async (a) => {
  const r = await argocd.runResourceAction(a.app, {
    action: "abort", resourceName: a.resourceName, namespace: a.namespace,
    group: "argoproj.io", version: "v1alpha1", kind: "Rollout",
  })                                                       // V4: actions/v2 abort, BUKAN patch langsung
  await ontology.write(insertAgentAction("recall", r))     // V7 audit
  return { recalled: true, phase: "Degraded" }             // V6
})
```

### 5. HITL resume dari frontend (V1)
```ts
// apps/api/routes/approvals.ts
GET("/api/approvals", () => checkpointer.listInterrupts())          // thread yang tertahan di interruptOn
POST("/api/approvals/:threadId/resume", ({ threadId, decision }) => {
  authz(currentUser, threadId)                                       // engineer berwenang
  return agent.invoke(new Command({ resume: decision }), { configurable: { thread_id: threadId } })
})
```

### 6. Frontend detail finding (server fetch + client approve)
```tsx
// apps/web/app/findings/[id]/page.tsx  (Server Component — read-heavy)
export default async function Page({ params }) {
  const f = await api.get(`/findings/${params.id}`)                  // evidence, exploit-path, correlation
  return <FindingDetail f={f}>
    <ApprovalDialog findingId={f.id} />                              // Client Component — interaktif
  </FindingDetail>
}
// ApprovalDialog → POST /findings/:id/verdict + (jika remediasi) /approvals/:thread/resume
```

## Dedup & suppression (V14, V15) — deterministik di TypeQL

Query di `packages/ontology/queries.ts` (verbatim dari kit-workflow): dedup by (entry-point, sink) → `correlation`; suppression = finding open yang root-cause cocok finding dismissed. Bukan embedding.

## Persistensi & sovereignty (§C)

- Checkpointer LangGraph (Postgres|SQLite self-hosted) → interrupt HITL persist, frontend bisa resume.
- Semua state (graph, checkpointer, memory) self-hosted; ⊥ SaaS eksternal (§C sovereignty).

## Mapping ke SPEC

```
dir/flow                     | tasks | invariants
packages/ontology            | T3    | V2,V3
packages/agents tools ont.   | T4    | V2,V7,V9
packages/agents/models       | T19   | V16,V17
packages/argocd + tools      | T5,T6 | V4,V5,V8
apps/api/webhook             | T7    | —
Foundation stage             | T13   | V11
Hunt stage                   | T8    | V9,V11,V13
Challenge+dedup              | T14   | V12,V14
Correlate+report             | T15   | V14
Learn writeback              | T11   | V7,V15
apps/web review surface      | T17   | V1,V12
cross-model harness          | T16   | V16
```

## Acceptance criteria (scaffold — T18)

1. `pnpm -w build` sukses; `packages/shared` tipe dipakai `apps/*` tanpa duplikasi.
2. `apps/api` start → `GET /health` 200; webhook menolak tanpa `X-OpenOrca-Secret` (401).
3. `apps/web` build; halaman findings render dari API (loading/empty/error state ada).
4. Klien ontology/argocd punya unit test boundary (zod parse, AUT3 retry, 206 throw).
5. ⊥ tipe domain terduplikasi di luar `packages/shared` (lint/grep check).
