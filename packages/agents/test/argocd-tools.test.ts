import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeepAgent } from "deepagents";
import { ArgoCDClient } from "@openorca/argocd";
import { OntologyClient } from "@openorca/ontology";
import { createArgoCDTools, INTERRUPT_ON, DESTRUCTIVE_TOOL_NAMES } from "../src/tools/argocd.ts";

// Fakes — these unit tests exercise tool wiring/branching, not the live cluster (that's smoke-recall.mjs).
function fakeArgo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    appStatus: async () => ({
      name: "x", syncStatus: "Synced", healthStatus: "Healthy",
      autosyncEnabled: false, hasRollout: false, rolloutAborted: false,
    }),
    sync: async () => ({ ok: true }),
    rollback: async () => ({ ok: true }),
    setAutosync: async () => ({ ok: true }),
    runResourceAction: async () => ({ ok: true }),
    ...overrides,
  } as unknown as ArgoCDClient;
}
const fakeOntology = { write: async () => ({ ok: true }) } as unknown as OntologyClient;

test("all six argocd/rollout tools register on createDeepAgent without collision (V9)", () => {
  const tools = createArgoCDTools(fakeArgo(), fakeOntology);
  assert.doesNotThrow(() => {
    createDeepAgent({
      tools: Object.values(tools),
      interruptOn: INTERRUPT_ON,
    });
  });
});

test("INTERRUPT_ON flags exactly the four destructive tools (V1)", () => {
  assert.deepEqual(
    Object.keys(INTERRUPT_ON).sort(),
    [...DESTRUCTIVE_TOOL_NAMES].sort(),
  );
  for (const name of DESTRUCTIVE_TOOL_NAMES) assert.equal(INTERRUPT_ON[name], true);
  // read-only tools must NOT be interrupt-gated
  assert.equal(INTERRUPT_ON["argocd_app_status"], undefined);
  assert.equal(INTERRUPT_ON["fleet_list"], undefined);
});

test("fleet_list returns real rows from the client and passes filters through", async () => {
  const seen: unknown[] = [];
  const rows = [
    { app: "demo-app", service: "demo", cluster: "https://k8s.local", namespace: "svc-demo", project: "openorca", syncStatus: "Synced", healthStatus: "Healthy" },
  ];
  const tools = createArgoCDTools(
    fakeArgo({ listApps: async (opts: unknown) => { seen.push(opts); return rows; } }),
    fakeOntology,
  );
  const out = JSON.parse(String(await tools.fleetList.invoke({ selector: "openorca.io/service=demo", project: "openorca" })));
  assert.equal(out.count, 1);
  assert.deepEqual(out.apps, rows, "must return real app rows, not a placeholder hint");
  assert.deepEqual(seen[0], { selector: "openorca.io/service=demo", projects: ["openorca"] });
});

test("fleet_list omits unset filters so the client's default selector applies", async () => {
  const seen: unknown[] = [];
  const tools = createArgoCDTools(
    fakeArgo({ listApps: async (opts: unknown) => { seen.push(opts); return []; } }),
    fakeOntology,
  );
  const out = JSON.parse(String(await tools.fleetList.invoke({})));
  assert.equal(out.count, 0);
  assert.deepEqual(seen[0], {}, "no selector/projects keys — the client owns the default");
});

test("argocd_rollback refuses a Rollout-managed app and points to rollout_recall (V4)", async () => {
  const tools = createArgoCDTools(
    fakeArgo({ appStatus: async () => ({ name: "x", syncStatus: "Synced", healthStatus: "Healthy", autosyncEnabled: true, hasRollout: true, rolloutAborted: false }) }),
    fakeOntology,
  );
  await assert.rejects(
    () => tools.argocdRollback.invoke({ app: "payments", historyId: 3 }),
    /manages a Rollout.*rollout_recall/s,
  );
});

test("argocd_rollback disables autosync first when it's on (V5), leaves it disabled", async () => {
  const calls: string[] = [];
  const tools = createArgoCDTools(
    fakeArgo({
      appStatus: async () => ({ name: "x", syncStatus: "OutOfSync", healthStatus: "Healthy", autosyncEnabled: true, hasRollout: false, rolloutAborted: false }),
      setAutosync: async (_n: string, enabled: boolean) => { calls.push(`setAutosync:${enabled}`); return {}; },
      rollback: async () => { calls.push("rollback"); return {}; },
    }),
    fakeOntology,
  );
  const out = JSON.parse(String(await tools.argocdRollback.invoke({ app: "web", historyId: 2 })));
  assert.deepEqual(calls, ["setAutosync:false", "rollback"], "must disable autosync BEFORE rollback");
  assert.equal(out.autosyncLeftDisabled, true);
});

test("rollout_recall reports the expected post-recall Degraded state (V6) and audits (V7)", async () => {
  let audited = false;
  const tools = createArgoCDTools(
    fakeArgo({ runResourceAction: async (_a: string, action: string) => ({ action }) }),
    { write: async () => { audited = true; return {}; } } as unknown as OntologyClient,
  );
  const out = JSON.parse(String(await tools.rolloutRecall.invoke({ app: "payments", resourceName: "payments-ro", namespace: "svc-payments" })));
  assert.equal(out.recalled, true);
  assert.equal(out.expectedPhase, "Degraded");
  assert.equal(out.audited, true);
  assert.equal(audited, true);
});

test("a failed audit write does not mask a succeeded fleet action, but is surfaced (V7)", async () => {
  const tools = createArgoCDTools(
    fakeArgo(),
    { write: async () => { throw new Error("typedb down"); } } as unknown as OntologyClient,
  );
  const out = JSON.parse(String(await tools.rolloutRecall.invoke({ app: "x", resourceName: "r", namespace: "n" })));
  assert.equal(out.recalled, true, "fleet action still reported as succeeded");
  assert.equal(out.audited, false);
  assert.match(out.auditError, /typedb down/);
});
