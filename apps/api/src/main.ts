// Bootstrap @openorca/api — webhook receiver (SPEC §T7) + GET /health.
// Semua env dari SPEC §I yang wajib di-fail-fast di sini, ⊥ diam-diam jalan setengah-wired.
import { ArgoCDClient } from "@openorca/argocd";
import { OntologyClient } from "@openorca/ontology";
import { resolveSandbox, runDetect, type ProviderKey } from "@openorca/agents";
import { createWebhookServer, type OpenOrcaEvent, type RolloutStatusSource } from "./webhook.ts";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[api] env ${name} ! — set dulu sebelum start (SPEC §I)`);
    process.exit(1);
  }
  return v;
};

const secret = required("OPENORCA_WEBHOOK_SECRET");
const argocd = new ArgoCDClient({
  baseUrl: required("ARGOCD_URL"),
  token: required("ARGOCD_TOKEN"),
  // Dev kind: self-signed. Prod must not set this.
  insecureTLS: process.env.ARGOCD_INSECURE_TLS === "true",
});

// Gate V6 — fail-open: kalau ArgoCD error/transien, jangan buang event; spawn saja
// (agent akan melihat status aktual sendiri via argocd_app_status).
const rolloutStatus: RolloutStatusSource = {
  async rolloutAborted(app) {
    try {
      return (await argocd.appStatus(app)).rolloutAborted;
    } catch (err) {
      console.error(`[api] V6 gate gagal utk app=${app} — fail-open:`, err);
      return false;
    }
  },
};

/**
 * Spawn point Detect — T8: webhook → runDetect (foundation gate V11 → hunt paralel
 * 5 spesialis + combination → persist findings ke graph).
 *
 * Hunt hanya aktif kalau env lengkap (OPENORCA_HUNT_ENABLED=true + TYPEDB_* + provider/model);
 * kalau tidak, event tetap dicatat sbg log — receiver ⊥ mati hanya karena hunt belum dikonfig.
 */
async function onEvent(event: OpenOrcaEvent): Promise<void> {
  if (process.env.OPENORCA_HUNT_ENABLED !== "true") {
    console.log(
      `[detect] app=${event.app} service=${event.service} health=${event.health} phase=${event.phase ?? "-"} revision=${event.revision ?? "-"} (hunt disabled)`,
    );
    return;
  }

  const ontology = new OntologyClient({
    baseUrl: required("TYPEDB_URL"),
    username: required("TYPEDB_USER"),
    password: required("TYPEDB_PASS"),
    databaseName: process.env.TYPEDB_DB ?? "openorca",
  });
  const sandbox = await resolveSandbox("docker-gvisor", {
    name: `openorca-hunter-${event.service}`,
    image: process.env.HUNTER_IMAGE ?? "alpine:3.20",
    // Dev tanpa gVisor terpasang boleh longgar via env — produksi wajib default (true).
    requireRunsc: process.env.HUNTER_REQUIRE_RUNSC !== "false",
  });
  const result = await runDetect(
    { service: event.service, threadId: `${event.service}:${event.revision ?? "HEAD"}` },
    {
      ontology,
      sandbox,
      provider: (process.env.HUNT_PROVIDER ?? "anthropic") as ProviderKey,
      modelId: required("HUNT_MODEL_ID"),
    },
  );
  console.log(
    `[detect] service=${event.service} selesai: foundationRan=${result.foundationRan} findings=${result.findingIds.length}`,
  );
}

const server = createWebhookServer({ secret, argocd: rolloutStatus, onEvent });

const port = Number(process.env.OPENORCA_PORT ?? 8080);
server.listen(port, () => {
  console.log(`[api] webhook receiver listening on :${port} POST /openorca/webhook`);
});
