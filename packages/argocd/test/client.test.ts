import { test } from "node:test";
import assert from "node:assert/strict";
import { ArgoCDClient, ArgoCDError } from "../src/client.ts";

/** Stub fetch with a route table; returns the captured requests for assertions. */
function withFetch(routes: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return routes(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const client = () => new ArgoCDClient({ baseUrl: "https://argo.test", token: "t" });

function appBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    spec: { syncPolicy: { automated: {} } },
    status: {
      sync: { status: "Synced", revision: "abc123" },
      health: { status: "Healthy" },
      operationState: { phase: "Succeeded" },
    },
    ...over,
  });
}

test("appStatus flattens app + resource-tree into a compact summary", async () => {
  const { restore } = withFetch((url) => {
    if (url.endsWith("/resource-tree")) {
      return new Response(JSON.stringify({ nodes: [{ group: "argoproj.io", kind: "Rollout", name: "demo", namespace: "svc-demo", health: { status: "Healthy" } }] }), { status: 200 });
    }
    return new Response(appBody(), { status: 200 });
  });
  try {
    const st = await client().appStatus("demo-app");
    assert.equal(st.syncStatus, "Synced");
    assert.equal(st.healthStatus, "Healthy");
    assert.equal(st.operationPhase, "Succeeded");
    assert.equal(st.revision, "abc123");
    assert.equal(st.hasRollout, true);
    assert.equal(st.rolloutAborted, false);
    assert.equal(st.autosyncEnabled, true);
  } finally { restore(); }
});

test("a Degraded Rollout is reported as rolloutAborted (V6 post-recall state)", async () => {
  const { restore } = withFetch((url) =>
    url.endsWith("/resource-tree")
      ? new Response(JSON.stringify({ nodes: [{ group: "argoproj.io", kind: "Rollout", health: { status: "Degraded" } }] }), { status: 200 })
      : new Response(appBody(), { status: 200 }),
  );
  try {
    const st = await client().appStatus("demo-app");
    assert.equal(st.rolloutAborted, true);
    assert.equal(st.rolloutPaused, false);
  } finally { restore(); }
});

test('a canary parked on a pause step reports as "Suspended" -> rolloutPaused (SPEC B10)', async () => {
  const { restore } = withFetch((url) =>
    url.endsWith("/resource-tree")
      ? new Response(JSON.stringify({ nodes: [{ group: "argoproj.io", kind: "Rollout", health: { status: "Suspended", message: "CanaryPauseStep" } }] }), { status: 200 })
      : new Response(appBody(), { status: 200 }),
  );
  try {
    const st = await client().appStatus("demo-app");
    assert.equal(st.rolloutPaused, true, "Suspended must map to rolloutPaused, not be ignored");
    assert.equal(st.rolloutAborted, false);
  } finally { restore(); }
});

test("autosync: automated:null means disabled, automated:{enabled:false} too", async () => {
  for (const [automated, expected] of [[null, false], [{ enabled: false }, false], [{}, true], [{ enabled: true }, true]] as const) {
    const { restore } = withFetch((url) =>
      url.endsWith("/resource-tree")
        ? new Response(JSON.stringify({ nodes: [] }), { status: 200 })
        : new Response(JSON.stringify({ spec: { syncPolicy: { automated } }, status: {} }), { status: 200 }),
    );
    try {
      const st = await client().appStatus("x");
      assert.equal(st.autosyncEnabled, expected, `automated=${JSON.stringify(automated)}`);
    } finally { restore(); }
  }
});

test("runResourceAction sends the WHOLE message in the body (proto body:'*'), no query params", async () => {
  const { calls, restore } = withFetch(() => new Response("{}", { status: 200 }));
  try {
    await client().runResourceAction("demo-app", "abort", {
      group: "argoproj.io", kind: "Rollout", version: "v1alpha1", name: "demo", namespace: "svc-demo",
    });
    const call = calls[0]!;
    assert.ok(!call.url.includes("?"), `must not put fields in the query string: ${call.url}`);
    const body = JSON.parse(String(call.init.body));
    assert.deepEqual(body, {
      name: "demo-app", namespace: "svc-demo", resourceName: "demo",
      version: "v1alpha1", group: "argoproj.io", kind: "Rollout", action: "abort",
    });
  } finally { restore(); }
});

test("setAutosync(false) sends a merge patch with automated:null", async () => {
  const { calls, restore } = withFetch(() => new Response("{}", { status: 200 }));
  try {
    await client().setAutosync("demo-app", false);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.patchType, "merge");
    assert.deepEqual(JSON.parse(body.patch), { spec: { syncPolicy: { automated: null } } });
  } finally { restore(); }
});

test("listApps filters SERVER-SIDE via selector + projects query params", async () => {
  const { calls, restore } = withFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));
  try {
    await client().listApps({ selector: "openorca.io/service=payments", projects: ["openorca", "other"] });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/api/v1/applications");
    assert.equal(url.searchParams.get("selector"), "openorca.io/service=payments");
    // `projects` is `repeated string` in ApplicationQuery — must repeat the key, not join with commas.
    assert.deepEqual(url.searchParams.getAll("projects"), ["openorca", "other"]);
  } finally { restore(); }
});

test("listApps defaults to the fleet label selector from kit-fleet's ApplicationSet template", async () => {
  const { calls, restore } = withFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));
  try {
    await client().listApps();
    assert.equal(new URL(calls[0]!.url).searchParams.get("selector"), "openorca.io/managed=true");
  } finally { restore(); }
});

test("listApps maps Applications to compact fleet rows (real live shape)", async () => {
  // Body copied from an actual live response (demo-app, labelled by the ApplicationSet template).
  const { restore } = withFetch(() =>
    new Response(JSON.stringify({
      items: [{
        metadata: { name: "demo-app", labels: { "openorca.io/managed": "true", "openorca.io/service": "demo" } },
        spec: { project: "openorca", destination: { server: "https://kubernetes.default.svc", namespace: "svc-demo" } },
        status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
      }],
    }), { status: 200 }),
  );
  try {
    const apps = await client().listApps();
    assert.deepEqual(apps, [{
      app: "demo-app",
      service: "demo",
      cluster: "https://kubernetes.default.svc",
      namespace: "svc-demo",
      project: "openorca",
      syncStatus: "Synced",
      healthStatus: "Healthy",
    }]);
  } finally { restore(); }
});

test("listApps handles items:null (the real empty-match shape) without throwing", async () => {
  const { restore } = withFetch(() => new Response(JSON.stringify({ items: null }), { status: 200 }));
  try {
    assert.deepEqual(await client().listApps(), []);
  } finally { restore(); }
});

test("listApps prefers destination.name over .server when both are present", async () => {
  const { restore } = withFetch(() =>
    new Response(JSON.stringify({
      items: [{
        metadata: { name: "a" },
        spec: { destination: { name: "prod-eu", server: "https://kubernetes.default.svc" } },
        status: {},
      }],
    }), { status: 200 }),
  );
  try {
    const [app] = await client().listApps();
    assert.equal(app!.cluster, "prod-eu");
    assert.equal(app!.syncStatus, "Unknown", "missing status must degrade to Unknown, not undefined");
  } finally { restore(); }
});

test("a non-2xx response throws ArgoCDError carrying status and server message", async () => {
  const { restore } = withFetch(() => new Response(JSON.stringify({ message: "another operation is already in progress" }), { status: 400 }));
  try {
    await assert.rejects(() => client().sync("demo-app"), (e: unknown) => {
      assert.ok(e instanceof ArgoCDError);
      assert.equal(e.status, 400);
      assert.match(e.message, /already in progress/);
      return true;
    });
  } finally { restore(); }
});
