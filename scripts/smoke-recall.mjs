#!/usr/bin/env node
// OO-003 AC5 — live recall drill against a real Rollout under Argo CD in kind:
//   deploy demo (v1 stable) -> trigger v2 canary (pauses) -> recall (abort) -> assert aborted
//   -> promote-full -> assert Healthy.
// Uses the openorca machine token via the SAME REST paths the tools use (V8: no kubeconfig writes).
// Requires: .env.openorca.local (ARGOCD_URL, ARGOCD_TOKEN), demo repo pushed with manifests/.
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, writeFileSync } from "node:fs";

// Dev smoke script only: kind's argocd-server uses a self-signed cert on localhost. This is a
// throwaway localhost script, not library code — the ArgoCDClient does per-request TLS control
// via undici instead. Never do this in the app.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const ARGOCD_URL = process.env.ARGOCD_URL;
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN;
// V10: target = Application hasil ApplicationSet (⊥ app manual). Env override utk fleksibilitas.
const APP = process.env.SMOKE_APP ?? "demo-openorca-kind";
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

  // 1. app harus sudah ada (ApplicationSet-generated, V10) — ⊥ create manual di sini.
  await api("GET", `/api/v1/applications/${APP}`);
  console.log(`==> Application ${APP} (appset-managed)`);

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

  // 3. Trigger canary VIA GIT (GitOps-native). Patch live-resource ⊥ jalan di bawah
  //    ApplicationSet: controller me-re-enforce template app (automated{selfHeal}) dan
  //    selfHeal membalikkan patch live-image di tengah tes — ditemukan live 2026-08-22.
  //    Bad deploy nyata = commit jelek masuk fleet repo; drill harus mengikuti itu.
  const { execSync } = await import("node:child_process");
  const FLEET_DIR = process.env.FLEET_DIR ?? "/tmp/openorca-fleet";
  const FLEET_FILE = `${FLEET_DIR}/envs/prod/demo/rollout.yaml`;
  const IMAGES = ["nginx:1.27.0-alpine", "nginx:1.27.1-alpine", "nginx:1.26.3-alpine"];
  const fleetYaml = readFileSync(FLEET_FILE, "utf8");
  const currentImage = fleetYaml.match(/image:\s*(\S+)/)?.[1] ?? "";
  const targetImage = IMAGES.find((i) => i !== currentImage) ?? IMAGES[0];
  const bump = (img) => {
    writeFileSync(FLEET_FILE, fleetYaml.replace(/image:\s*\S+/, `image: ${img}`));
    execSync("git add -A && git commit -qm 'smoke: image bump' && git push -q origin main", { cwd: FLEET_DIR });
  };
  const beforeRev = (await api("GET", `/api/v1/applications/${APP}`)).status?.sync?.revision;
  bump(targetImage);
  // SHA eksplisit — "revision berubah" ⊥ cukup (bisa ke-revisi lama yg tertunda).
  const newRev = execSync("git rev-parse HEAD", { cwd: FLEET_DIR }).toString().trim();
  await waitFor("argocd synced at bumped revision", async () => {
    // Re-issue refresh tiap iterasi: repo-server resolve HEAD saat refresh, bukan realtime.
    await api(
      "PATCH",
      `/api/v1/applications/${APP}`,
      { name: APP, patchType: "merge", patch: JSON.stringify({ metadata: { annotations: { "argocd.argoproj.io/refresh": "normal" } } }) },
    ).catch(() => {});
    const app = await api("GET", `/api/v1/applications/${APP}`);
    return app.status?.sync?.status === "Synced" && app.status?.sync?.revision === newRev ? true : null;
  });
  console.log(`==> pushed ${targetImage} (was: ${currentImage}) to fleet repo — canary should start and pause at setWeight:50`);

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

  // 6. ROLL FORWARD: fix di-push (revert ke image sebelumnya) → autosync syncs →
  //    retry (clear abort) + promote-full menyelesaikan canary yang parkir.
  bump(currentImage);
  await api("POST", `/api/v1/applications/${APP}/sync`, { name: APP }).catch(() => {});  await api("POST", `/api/v1/applications/${APP}/resource/actions/v2`, {
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
  console.log("==> smoke-recall PASSED: recall -> abort -> promote -> Healthy");
}

main().catch((err) => {
  console.error("smoke-recall FAILED:", err.message);
  process.exit(1);
});
