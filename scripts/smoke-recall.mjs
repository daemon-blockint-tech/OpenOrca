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
  console.error("smoke-recall: set ARGOCD_URL and ARGOCD_TOKEN (source .env.openorca.local)");
  process.exit(1);
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

  // 3. trigger a v2 canary by bumping the image via a resource action is not built-in; instead patch
  //    the Rollout image through the app's managed resource. Simplest: set image via kubectl-free path —
  //    ArgoCD's resource actions don't include set-image, so we edit the live resource via PATCH RPC on
  //    the managed resource. Use the app's managedResources patch endpoint.
  const roFull = await api(
    "GET",
    `/api/v1/applications/${APP}/resource?name=${ro.name}&namespace=${ro.namespace}&group=argoproj.io&version=v1alpha1&kind=Rollout`,
  );
  const manifest = JSON.parse(roFull.manifest);
  const patch = [{ op: "replace", path: "/spec/template/spec/containers/0/image", value: "nginx:1.27.1-alpine" }];
  await api(
    "POST",
    `/api/v1/applications/${APP}/resource?name=${ro.name}&namespace=${ro.namespace}&group=argoproj.io&version=v1alpha1&kind=Rollout&patchType=application/json-patch%2Bjson`,
    { patch: JSON.stringify(patch) },
  );
  console.log("==> bumped image to v2 — canary should start and pause at setWeight:50");

  // 4. wait for the canary to be Progressing/Paused (something recall can abort)
  await waitFor("Rollout Progressing/Paused on canary", async () => {
    const n = await rolloutNode();
    return n && (n.health?.status === "Progressing" || n.health?.status === "Paused") ? n : null;
  });
  console.log("==> canary in progress (recall has something to abort)");

  // 5. RECALL via the SAME action the tool uses (V4): actions/v2 abort
  await api(
    "POST",
    `/api/v1/applications/${APP}/resource/actions/v2?resourceName=${ro.name}&namespace=${ro.namespace}&group=argoproj.io&kind=Rollout&version=v1alpha1`,
    { action: "abort", resourceName: ro.name, namespace: ro.namespace },
  );
  const aborted = await waitFor("Rollout aborted (Degraded)", async () => {
    const n = await rolloutNode();
    return n?.health?.status === "Degraded" ? n : null;
  });
  console.log(`==> RECALL ok: Rollout ${aborted.name} is Degraded (aborted) — expected post-recall state (V6)`);

  // 6. ROLL FORWARD: retry (clear abort) then promote-full
  await api(
    "POST",
    `/api/v1/applications/${APP}/resource/actions/v2?resourceName=${ro.name}&namespace=${ro.namespace}&group=argoproj.io&kind=Rollout&version=v1alpha1`,
    { action: "retry", resourceName: ro.name, namespace: ro.namespace },
  );
  await api(
    "POST",
    `/api/v1/applications/${APP}/resource/actions/v2?resourceName=${ro.name}&namespace=${ro.namespace}&group=argoproj.io&kind=Rollout&version=v1alpha1`,
    { action: "promote-full", resourceName: ro.name, namespace: ro.namespace },
  );
  await waitFor("Rollout Healthy after promote-full", async () => {
    const n = await rolloutNode();
    return n?.health?.status === "Healthy" ? n : null;
  });
  console.log("==> ROLL FORWARD ok: Rollout Healthy after promote-full");
  console.log("==> smoke-recall PASSED: recall -> abort -> promote -> Healthy");
}

main().catch((err) => {
  console.error("smoke-recall FAILED:", err.message);
  process.exit(1);
});
