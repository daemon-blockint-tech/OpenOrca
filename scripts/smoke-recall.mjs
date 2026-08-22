#!/usr/bin/env node
// OO-003 AC5 — live recall drill against a real Rollout under Argo CD in kind:
//   deploy demo (v1 stable) -> trigger v2 canary (pauses) -> recall (abort) -> assert aborted
//   -> promote-full -> assert Healthy.
// Uses the openorca machine token via the SAME REST paths the tools use (V8: no kubeconfig writes).
// Requires: .env.openorca.local (ARGOCD_URL, ARGOCD_TOKEN), demo repo pushed with manifests/.
import { setTimeout as sleep } from "node:timers/promises";

// Dev smoke script only: kind's argocd-server uses a self-signed cert on localhost. This is a
// throwaway localhost script, not library code — the ArgoCDClient does per-request TLS control
// via undici instead. Never do this in the app.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const ARGOCD_URL = process.env.ARGOCD_URL;
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN;
const APP = "demo-app";
const DEMO_REPO = "https://github.com/daemon-blockint-tech/openorca-demo-app.git";
const NS = "svc-demo";
if (!ARGOCD_URL || !ARGOCD_TOKEN) {
  // Exit NON-ZERO: a missing token means the drill did not run, which must never be mistaken
  // for a pass. (It briefly exited 0 here, and a CI/reviewer run read that as success.)
  console.error("smoke-recall: set ARGOCD_URL and ARGOCD_TOKEN (source .env.openorca.local)");
  process.exit(2);
}

async function api(method, path, body) {
  const res = await fetch(`${ARGOCD_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ARGOCD_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${parsed.message ?? text}`);
  return parsed;
}

async function waitFor(desc, fn, { tries = 40, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(delayMs);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}

async function rolloutNode() {
  const tree = await api("GET", `/api/v1/applications/${APP}/resource-tree`);
  return (tree.nodes ?? []).find((n) => n.group === "argoproj.io" && n.kind === "Rollout");
}

async function main() {
  // 0. RESET: pastikan Rollout mulai dari Healthy. Urutan penting dgn autosync ON +
  //    pause tanpa durasi (steps: setWeight:50, pause:{}): retry clears abort → sync
  //    konvergen live ke git → promote-full melewati pause tak-terhingga. Tanpa sync,
  //    promote-full selesai lalu autosync langsung picu canary baru yang parkir lagi.
  const pre = await rolloutNode().catch(() => null);
  if (pre && pre.health?.status !== "Healthy") {
    console.log(`==> resetting Rollout (current: ${pre.health?.status})`);
    const act = (action) =>
      api("POST", `/api/v1/applications/${APP}/resource/actions/v2`, {
        name: APP, namespace: NS, resourceName: "demo",
        version: "v1alpha1", group: "argoproj.io", kind: "Rollout", action,
      }).catch(() => {});
    await act("retry");
    await api("POST", `/api/v1/applications/${APP}/sync`, { name: APP }).catch(() => {});
    // Tunggu revisi baru dari sync parkir (Suspended/pause) ATAU langsung Healthy —
    // promote-full sebelum parkir = mempromosikan revisi lama, canary baru tetap parkir.
    await waitFor("Rollout parked or healthy", async () => {
      const n = await rolloutNode();
      const s = n?.health?.status;
      return s === "Healthy" || s === "Suspended" ? n : null;
    });
    await act("promote-full");
  }

  // 1. ensure the Application exists (create via API — the machine account has applications,* on openorca/*)
  const exists = await api("GET", `/api/v1/applications/${APP}`).then(() => true).catch(() => false);
  if (!exists) {
    await api("POST", "/api/v1/applications", {
      metadata: { name: APP, labels: { "openorca.io/managed": "true", "openorca.io/service": "demo" } },
      spec: {
        project: "openorca",
        source: { repoURL: DEMO_REPO, path: "manifests", targetRevision: "HEAD" },
        destination: { server: "https://kubernetes.default.svc", namespace: NS },
        syncPolicy: { automated: {}, syncOptions: ["CreateNamespace=true"] },
      },
    });
    console.log(`==> created Application ${APP}`);
  } else {
    console.log(`==> Application ${APP} already exists`);
  }

  // 2. sync + wait for the Rollout to exist and become Healthy (v1 stable).
  // The app has autosync on, so an operation may already be running from create — that's fine,
  // "another operation is already in progress" just means a sync is underway.
  await api("POST", `/api/v1/applications/${APP}/sync`, { name: APP }).catch((e) => {
    if (!/already in progress/i.test(e.message)) throw e;
    console.log("==> sync already in progress (autosync) — continuing");
  });
  const ro = await waitFor("Rollout resource to appear", rolloutNode);
  console.log(`==> Rollout ${ro.name} present in ${ro.namespace}`);
  await waitFor("Rollout Healthy (v1 stable)", async () => {
    const n = await rolloutNode();
    return n?.health?.status === "Healthy" ? n : null;
  });
  console.log("==> Rollout Healthy at v1 (stable)");
  // Patch hanya aman SETELAH operasi sync ArgoCD benar2 selesai — patch di tengah
  // operasi akan ditimpa manifest git sesaat kemudian (ditemukan saat review OO-003).
  await waitFor("sync operation settled", async () => {
    const app = await api("GET", `/api/v1/applications/${APP}`);
    const done = !app.status?.operationState || ["Succeeded", "Failed", "Error"].includes(app.status.operationState.phase);
    return done && app.status?.sync?.status === "Synced" ? true : null;
  });

  // 3. trigger a v2 canary by bumping the image via a resource action is not built-in; instead patch
  //    the Rollout image through the app's managed resource. Simplest: set image via kubectl-free path —
  //    ArgoCD's resource actions don't include set-image, so we edit the live resource via PATCH RPC on
  //    the managed resource. Use the app's managedResources patch endpoint.
  // PatchResource is fiddly (SPEC §B B9). Two gotchas, both found by trial against a live server:
  //   1. the resource is identified by `resourceName` in the QUERY STRING, not `name` (that's the app);
  //   2. grpc-gateway binds the request BODY to the proto's `patch` field, which is a plain STRING —
  //      so the body must be a JSON-encoded *string* (a bare `"..."`), not an object. Sending
  //      `{patch: "..."}` returns "cannot unmarshal object into Go value of type string".
  // Bump ke image yang BERBEDA dari current — patch sama = no-op, canary takkan terpicu
  // (ditemukan saat review OO-003: run kedua selalu timeout di "mid-canary").
  const IMAGES = ["nginx:1.27.0-alpine", "nginx:1.27.1-alpine", "nginx:1.26.3-alpine"];
  const currentImage = await api(
    "GET",
    `/api/v1/applications/${APP}/managed-resources`,
  )
    .then((r) => {
      // items mencakup SEMUA resource app; ambil node Rollout-nya. liveState adalah
      // JSON STRING, bukan object (ditemukan saat review OO-003).
      const ro = (r.items ?? []).find((it) => it.kind === "Rollout" && it.namespace === NS);
      return JSON.parse(ro?.liveState ?? "{}")?.spec?.template?.spec?.containers?.[0]?.image;
    })
    .catch(() => undefined);
  const targetImage = IMAGES.find((i) => i !== currentImage) ?? IMAGES[0];
  const mergePatch = JSON.stringify({
    spec: { template: { spec: { containers: [{ name: "demo", image: targetImage }] } } },
  });
  await api(
    "POST",
    `/api/v1/applications/${APP}/resource?resourceName=${encodeURIComponent(ro.name)}` +
      `&namespace=${encodeURIComponent(ro.namespace)}&group=argoproj.io&version=v1alpha1&kind=Rollout` +
      `&patchType=application/merge-patch%2Bjson`,
    mergePatch, // api() JSON-encodes this string → a bare JSON string body, as the gateway expects
  );
  // 3a. Matikan autosync dulu (V5 pattern): tanpa ini autosync langsung me-revert
  //     patch live-image kembali ke versi git sebelum canary sempat parkir.
  await api(
    "PATCH",
    `/api/v1/applications/${APP}`,
    { name: APP, patchType: "merge", patch: JSON.stringify({ spec: { syncPolicy: { automated: null } } }) },
  );
  console.log("==> autosync disabled untuk fase uji");
  console.log(`==> bumped image to ${targetImage} (was: ${currentImage || "?"}) — canary should start and pause at setWeight:50`);

  // 4. wait for the canary to be mid-flight (something recall can abort).
  // NOTE: Argo CD maps a canary parked on a `pause` step to health status "Suspended"
  // (message CanaryPauseStep) — NOT "Paused"/"Progressing" (SPEC §B B10).
  await waitFor("Rollout mid-canary (Suspended/Progressing)", async () => {
    const n = await rolloutNode();
    const s = n?.health?.status;
    return s === "Suspended" || s === "Progressing" ? n : null;
  });
  console.log("==> canary in progress (recall has something to abort)");

  // 5. RECALL via the SAME action the tool uses (V4): actions/v2 abort
  await api("POST", `/api/v1/applications/${APP}/resource/actions/v2`, {
    name: APP,
    namespace: ro.namespace,
    resourceName: ro.name,
    version: "v1alpha1",
    group: "argoproj.io",
    kind: "Rollout",
    action: "abort",
  });
  const aborted = await waitFor("Rollout aborted (Degraded)", async () => {
    const n = await rolloutNode();
    return n?.health?.status === "Degraded" ? n : null;
  });
  console.log(`==> RECALL ok: Rollout ${aborted.name} is Degraded (aborted) — expected post-recall state (V6)`);

  // 6. ROLL FORWARD: retry (clear abort) then promote-full
  await api("POST", `/api/v1/applications/${APP}/resource/actions/v2`, {
    name: APP,
    namespace: ro.namespace,
    resourceName: ro.name,
    version: "v1alpha1",
    group: "argoproj.io",
    kind: "Rollout",
    action: "retry",
  });
  await api("POST", `/api/v1/applications/${APP}/resource/actions/v2`, {
    name: APP,
    namespace: ro.namespace,
    resourceName: ro.name,
    version: "v1alpha1",
    group: "argoproj.io",
    kind: "Rollout",
    action: "promote-full",
  });
  await waitFor("Rollout Healthy after promote-full", async () => {
    const n = await rolloutNode();
    return n?.health?.status === "Healthy" ? n : null;
  });
  console.log("==> ROLL FORWARD ok: Rollout Healthy after promote-full");

  // 7. CLEANUP: pulihkan autosync (keputusan re-enable selalu eksplisit — di sini script
  //    smoke yang mengembalikan kondisi awal, bukan agent).
  await api(
    "PATCH",
    `/api/v1/applications/${APP}`,
    { name: APP, patchType: "merge", patch: JSON.stringify({ spec: { syncPolicy: { automated: {} } } }) },
  );
  console.log("==> autosync restored");
  console.log("==> smoke-recall PASSED: recall -> abort -> promote -> Healthy");
}

main().catch((err) => {
  console.error("smoke-recall FAILED:", err.message);
  process.exit(1);
});
