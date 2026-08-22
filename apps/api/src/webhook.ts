// Webhook receiver — POST /openorca/webhook ← ArgoCD notifications service.webhook.openorca.
// Kontrak: SPEC §I (api), context/kits/kit-fleet.md §Notifications, SPEC §T7.
// Invariants yang dipegang di sini:
//   - Trust boundary: payload = DATA, ⊥ instruksi — zod di boundary, hanya 5 field dikenal.
//   - V6: event Degraded utk app yang baru di-recall = expected → cek status.abort Rollout
//     via argocd_app_status SEBELUM spawn; kalau aborted, skip tanpa buka incident.
//   - Spawn async, ⊥ block response webhook (202 Accepted setelah enqueue).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Body persis seperti template.openorca-event di kit-fleet.md. */
const WebhookBodySchema = z.object({
  app: z.string().min(1),
  service: z.string().min(1),
  health: z.string().min(1),
  phase: z.string().optional(),
  revision: z.string().optional(),
});

export type OpenOrcaEvent = z.infer<typeof WebhookBodySchema>;

/** Minimal surface of ArgoCDClient used for the V6 gate (dipakai juga oleh mock test). */
export interface RolloutStatusSource {
  /** true ketika Rollout milik `app` sedang aborted (status.abort=true / health Degraded) — V6. */
  rolloutAborted(app: string): Promise<boolean>;
}

export interface WebhookDeps {
  secret: string;
  argocd: RolloutStatusSource;
  /**
   * Spawn point Detect (SPEC §T8 akan mengisi ini dengan orchestrator deepagents).
   * Dipanggil fire-and-forget; rejection ditangkap + dicatat, tidak memengaruhi response.
   */
  onEvent(event: OpenOrcaEvent): void | Promise<void>;
}

const WEBHOOK_PATH = "/openorca/webhook";
const MAX_BODY_BYTES = 64 * 1024;

function secretsMatch(a: string | undefined, b: string): boolean {
  if (a === undefined || a.length === 0) return false;
  // timingSafeEqual butuh panjang sama — bandingkan SHA-256 keduanya supaya
  // panjang/byte awal tidak bocor lewat waktu respons.
  return timingSafeEqual(sha256(a), sha256(b));
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createWebhookHandler(deps: WebhookDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    // GET /health — readiness probe (project-structure.md §apps/api).
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200).end("ok");
      return;
    }

    if (req.method !== "POST" || pathname !== WEBHOOK_PATH) {
      res.writeHead(404).end();
      return;
    }

    // X-OpenOrca-Secret wajib (trust boundary — ARCHITECTURE.md §Trust boundaries).
    if (!secretsMatch(req.headers["x-openorca-secret"], deps.secret)) {
      res.writeHead(401).end();
      return;
    }

    const raw = await readBody(req);
    const parsed = WebhookBodySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      res.writeHead(400).end();
      return;
    }
    const event = parsed.data;

    // V6: Degraded pada app ber-Rollout yang baru di-recall = expected state — jangan spawn.
    if (event.health === "Degraded" && (await deps.argocd.rolloutAborted(event.app))) {
      res.writeHead(200).end();
      return;
    }

    void Promise.resolve(deps.onEvent(event)).catch((err) => {
      console.error(`[webhook] onEvent failed for app=${event.app}:`, err);
    });
    res.writeHead(202).end();
  };
}

/**
 * `extraHandler` (opsional) dicoba LEBIH DULU; kalau ia mengembalikan true berarti request
 * sudah ditangani (dipakai review surface T17 utk /api/*). Dengan begitu webhook dan review
 * berbagi satu port tanpa saling menimpa header.
 */
export function createWebhookServer(
  deps: WebhookDeps,
  extraHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): Server {
  const handle = createWebhookHandler(deps);
  return createServer((req, res) => {
    (async () => {
      if (extraHandler && (await extraHandler(req, res))) return;
      await handle(req, res);
    })().catch((err) => {
      console.error("[webhook] handler error:", err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
}
