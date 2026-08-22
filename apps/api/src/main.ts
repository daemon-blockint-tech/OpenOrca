// Bootstrap @openorca/api — webhook receiver (SPEC §T7) + GET /health.
// Semua env dari SPEC §I yang wajib di-fail-fast di sini, ⊥ diam-diam jalan setengah-wired.
import { ArgoCDClient } from "@openorca/argocd";
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
 * Spawn point Detect. T8 akan mengganti stub ini dengan orchestrator deepagents
 * (foundation → hunt). Untuk sekarang event dicatat sebagai bukti alur.
 */
async function onEvent(event: OpenOrcaEvent): Promise<void> {
  // TODO(T8): spawn orchestrator — hunt(service, revision)
  console.log(
    `[detect] app=${event.app} service=${event.service} health=${event.health} phase=${event.phase ?? "-"} revision=${event.revision ?? "-"}`,
  );
}

const server = createWebhookServer({ secret, argocd: rolloutStatus, onEvent });

const port = Number(process.env.OPENORCA_PORT ?? 8080);
server.listen(port, () => {
  console.log(`[api] webhook receiver listening on :${port} POST /openorca/webhook`);
});
