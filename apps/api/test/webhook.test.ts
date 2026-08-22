// Webhook receiver tests — SPEC §T7, V6, trust boundary (secret header), kit-fleet template body.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createWebhookServer, type OpenOrcaEvent, type RolloutStatusSource } from "../src/webhook.ts";

const SECRET = "test-secret";

/** argocd mock — rolloutAborted dikontrol per-test. */
function fakeArgocd(aborted: boolean): RolloutStatusSource {
  return { rolloutAborted: async (_app) => aborted };
}

function startServer(deps: Parameters<typeof createWebhookServer>[0]): Promise<string> {
  return new Promise((resolve) => {
    const server = createWebhookServer(deps);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
    after(() => server.close());
  });
}

const validBody = {
  app: "demo-app",
  service: "checkout",
  health: "Healthy",
  phase: "Succeeded",
  revision: "abc123",
};

describe("webhook POST /openorca/webhook", () => {
  it("menolak tanpa header X-OpenOrca-Secret → 401", async () => {
    const url = await startServer({ secret: SECRET, argocd: fakeArgocd(false), onEvent: () => {} });
    const res = await fetch(`${url}/openorca/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    assert.equal(res.status, 401);
  });

  it("menolak secret salah → 401", async () => {
    const url = await startServer({ secret: SECRET, argocd: fakeArgocd(false), onEvent: () => {} });
    const res = await fetch(`${url}/openorca/webhook`, {
      method: "POST",
      headers: { "X-OpenOrca-Secret": "wrong" },
      body: JSON.stringify(validBody),
    });
    assert.equal(res.status, 401);
  });

  it("payload tidak sesuai schema → 400, ⊥ spawn", async () => {
    const events: OpenOrcaEvent[] = [];
    const url = await startServer({
      secret: SECRET,
      argocd: fakeArgocd(false),
      onEvent: (e) => void events.push(e),
    });
    const res = await fetch(`${url}/openorca/webhook`, {
      method: "POST",
      headers: { "X-OpenOrca-Secret": SECRET },
      // health hilang — field wajib template.openorca-event
      body: JSON.stringify({ app: "demo-app", service: "checkout" }),
    });
    assert.equal(res.status, 400);
    assert.equal(events.length, 0);
  });

  it("event valid → 202 dan onEvent dipanggil dengan event terparse", async () => {
    const events: OpenOrcaEvent[] = [];
    const url = await startServer({
      secret: SECRET,
      argocd: fakeArgocd(false),
      onEvent: (e) => void events.push(e),
    });
    const res = await fetch(`${url}/openorca/webhook`, {
      method: "POST",
      headers: { "X-OpenOrca-Secret": SECRET },
      body: JSON.stringify(validBody),
    });
    assert.equal(res.status, 202);
    // fire-and-forget: beri satu tick microtask sebelum assert
    await new Promise((r) => setImmediate(r));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], validBody);
  });

  it("V6: Degraded + Rollout aborted → skip spawn, 200 tanpa incident", async () => {
    const events: OpenOrcaEvent[] = [];
    let abortCheckedFor: string | undefined;
    const argocd: RolloutStatusSource & { lastApp(): string | undefined } = {
      rolloutAborted: async (app) => {
        abortCheckedFor = app;
        return true;
      },
      lastApp: () => abortCheckedFor,
    };
    const url = await startServer({ secret: SECRET, argocd, onEvent: (e) => void events.push(e) });

    const res = await fetch(`${url}/openorca/webhook`, {
      method: "POST",
      headers: { "X-OpenOrca-Secret": SECRET },
      body: JSON.stringify({ ...validBody, health: "Degraded" }),
    });
    assert.equal(res.status, 200);
    assert.equal(events.length, 0);
    assert.equal(argocd.lastApp(), "demo-app"); // gate dicek dengan app dari payload
  });

  it("Degraded tapi Rollout TIDAK aborted → spawn normal (202)", async () => {
    const events: OpenOrcaEvent[] = [];
    const url = await startServer({
      secret: SECRET,
      argocd: fakeArgocd(false),
      onEvent: (e) => void events.push(e),
    });
    const res = await fetch(`${url}/openorca/webhook`, {
      method: "POST",
      headers: { "X-OpenOrca-Secret": SECRET },
      body: JSON.stringify({ ...validBody, health: "Degraded" }),
    });
    assert.equal(res.status, 202);
    await new Promise((r) => setImmediate(r));
    assert.equal(events.length, 1);
  });

  it("path lain → 404", async () => {
    const url = await startServer({ secret: SECRET, argocd: fakeArgocd(false), onEvent: () => {} });
    const res = await fetch(`${url}/other`);
    assert.equal(res.status, 404);
  });

  it("GET /health → 200 tanpa secret", async () => {
    const url = await startServer({ secret: SECRET, argocd: fakeArgocd(false), onEvent: () => {} });
    const res = await fetch(`${url}/health`);
    assert.equal(res.status, 200);
  });
});
