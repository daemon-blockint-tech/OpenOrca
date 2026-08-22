// Argo CD REST client — the only control path to the fleet (SPEC V8: API server + machine token,
// never kubeconfig/direct CR writes). Hand-typed against the argocd-server REST surface; no SDK.
// Call chains verified against argoproj/argo-cd source — see context/refs/research/gaps.md.

export interface ArgoCDClientConfig {
  baseUrl: string;
  token: string;
  /** Dev only: kind's argocd-server serves a self-signed cert. Never true in prod. */
  insecureTLS?: boolean;
}

export interface AppStatus {
  name: string;
  syncStatus: string; // Synced | OutOfSync | Unknown
  healthStatus: string; // Healthy | Degraded | Progressing | Missing | Suspended | Unknown
  operationPhase?: string; // Running | Succeeded | Failed | Error | Terminating
  revision?: string;
  autosyncEnabled: boolean;
  /** true when a managed Rollout resource is present in the app's resource tree. */
  hasRollout: boolean;
  /** true when a managed Rollout is currently aborted (status.abort) — V6 expected state. */
  rolloutAborted: boolean;
  /** true when a managed Rollout is parked on a canary `pause` step (Argo CD reports "Suspended"). */
  rolloutPaused: boolean;
}

/** One row of the fleet listing (kit-agent-tools.md §fleet_list). */
export interface FleetApp {
  app: string;
  /** From the `openorca.io/service` label — the join key to `service` in the context graph. */
  service?: string;
  /** Destination cluster: `spec.destination.name` if set, else `.server`. */
  cluster?: string;
  namespace?: string;
  project?: string;
  syncStatus: string;
  healthStatus: string;
}

export interface ListAppsOptions {
  /** Kubernetes label selector, e.g. `openorca.io/managed=true` (filtered server-side). */
  selector?: string;
  /** Restrict to these Argo CD projects (filtered server-side). */
  projects?: string[];
}

export class ArgoCDError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ArgoCDError";
  }
}

interface ResourceNode {
  group?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  health?: { status?: string };
}

export class ArgoCDClient {
  #config: ArgoCDClientConfig;
  // Node's fetch honours NODE_TLS_REJECT_UNAUTHORIZED; for dev self-signed certs we set an
  // undici dispatcher per-request instead of poisoning the whole process. Resolved lazily.
  #dispatcher: unknown;

  constructor(config: ArgoCDClientConfig) {
    this.#config = config;
  }

  async #agent(): Promise<unknown> {
    if (!this.#config.insecureTLS) return undefined;
    if (this.#dispatcher !== undefined) return this.#dispatcher;
    const { Agent } = await import("undici");
    this.#dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    return this.#dispatcher;
  }

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    const dispatcher = await this.#agent();
    const res = await fetch(`${this.#config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#config.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // @ts-expect-error undici-specific option, ignored by the types but honoured at runtime
      dispatcher,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = (parsed as { message?: string }).message ?? text ?? `HTTP ${res.status}`;
      throw new ArgoCDError(res.status, `argocd ${method} ${path} → ${res.status}: ${msg}`);
    }
    return parsed;
  }

  /** Raw Application object. */
  getApp(name: string): Promise<unknown> {
    return this.#req("GET", `/api/v1/applications/${encodeURIComponent(name)}`);
  }

  /**
   * List Applications, filtered SERVER-SIDE (verified live: `selector` and `projects` are real
   * ApplicationQuery fields on the List RPC — filtering here rather than fetching everything and
   * filtering in JS keeps the payload small and the RBAC boundary honest).
   * Default selector is the fleet label from kit-fleet.md's ApplicationSet template.
   */
  async listApps(options: ListAppsOptions = {}): Promise<FleetApp[]> {
    const { selector = "openorca.io/managed=true", projects } = options;
    const params = new URLSearchParams();
    if (selector) params.set("selector", selector);
    for (const p of projects ?? []) params.append("projects", p);
    const qs = params.toString();

    const res = (await this.#req(
      "GET",
      `/api/v1/applications${qs ? `?${qs}` : ""}`,
    )) as {
      items?: Array<{
        metadata?: { name?: string; labels?: Record<string, string> };
        spec?: {
          project?: string;
          destination?: { server?: string; name?: string; namespace?: string };
        };
        status?: { sync?: { status?: string }; health?: { status?: string } };
      }> | null;
    };

    // `items` is null (not []) when nothing matches — a real shape, seen live.
    return (res.items ?? []).map((it) => ({
      app: it.metadata?.name ?? "",
      service: it.metadata?.labels?.["openorca.io/service"],
      cluster: it.spec?.destination?.name ?? it.spec?.destination?.server,
      namespace: it.spec?.destination?.namespace,
      project: it.spec?.project,
      syncStatus: it.status?.sync?.status ?? "Unknown",
      healthStatus: it.status?.health?.status ?? "Unknown",
    }));
  }

  /** Resource tree (used to detect a managed Rollout and its abort state). */
  resourceTree(name: string): Promise<{ nodes?: ResourceNode[] }> {
    return this.#req(
      "GET",
      `/api/v1/applications/${encodeURIComponent(name)}/resource-tree`,
    ) as Promise<{ nodes?: ResourceNode[] }>;
  }

  /** Summarised, context-cheap status (kit-agent-tools.md §argocd_app_status). */
  async appStatus(name: string): Promise<AppStatus> {
    const app = (await this.getApp(name)) as {
      spec?: { syncPolicy?: { automated?: { enabled?: boolean } | null } };
      status?: {
        sync?: { status?: string; revision?: string };
        health?: { status?: string };
        operationState?: { phase?: string };
      };
    };
    const tree = await this.resourceTree(name).catch(() => ({ nodes: [] as ResourceNode[] }));
    const rolloutNodes = (tree.nodes ?? []).filter(
      (n) => n.group === "argoproj.io" && n.kind === "Rollout",
    );
    const rolloutAborted = rolloutNodes.some(
      (n) => (n.health?.status ?? "") === "Degraded",
    );
    // Argo CD reports a canary parked on a `pause` step as "Suspended" (message CanaryPauseStep),
    // not "Paused" — verified live (SPEC §B B10).
    const rolloutPaused = rolloutNodes.some(
      (n) => (n.health?.status ?? "") === "Suspended",
    );

    // automated present (even {}) means autosync on; `enabled:false` explicitly disables it.
    const automated = app.spec?.syncPolicy?.automated;
    const autosyncEnabled = automated != null && automated.enabled !== false;

    return {
      name,
      syncStatus: app.status?.sync?.status ?? "Unknown",
      healthStatus: app.status?.health?.status ?? "Unknown",
      operationPhase: app.status?.operationState?.phase,
      revision: app.status?.sync?.revision,
      autosyncEnabled,
      hasRollout: rolloutNodes.length > 0,
      rolloutAborted,
      rolloutPaused,
    };
  }

  /** POST /sync — sets .operation; async by design (poll appStatus for terminal phase). */
  sync(name: string, revision?: string): Promise<unknown> {
    return this.#req("POST", `/api/v1/applications/${encodeURIComponent(name)}/sync`, {
      name,
      ...(revision ? { revision } : {}),
    });
  }

  /** POST /rollback — sync to a historical revision by history id. */
  rollback(name: string, id: number): Promise<unknown> {
    return this.#req("POST", `/api/v1/applications/${encodeURIComponent(name)}/rollback`, {
      name,
      id,
    });
  }

  /** Toggle spec.syncPolicy.automated (V5: must disable autosync before rollback). */
  setAutosync(name: string, enabled: boolean): Promise<unknown> {
    // ApplicationService.Patch RPC: a JSON merge patch. `automated: {}` enables, `null` disables.
    const patch = JSON.stringify({
      spec: { syncPolicy: { automated: enabled ? {} : null } },
    });
    return this.#req("PATCH", `/api/v1/applications/${encodeURIComponent(name)}`, {
      name,
      patch,
      patchType: "merge",
    });
  }

  /**
   * Run a Lua resource action on a managed resource (V4: the correct recall/roll-forward path
   * for a Rollout under Argo CD — action `abort` / `promote-full` / `retry`, NOT a raw patch).
   */
  runResourceAction(
    name: string,
    action: string,
    resource: { group: string; kind: string; version: string; name: string; namespace: string },
  ): Promise<unknown> {
    // RunResourceActionV2 is declared `body: "*"` in application.proto — the ENTIRE message goes
    // in the JSON body, and query params are ignored (unlike the deprecated V1, which bodies only
    // `action`). Splitting fields across the query string yields a misleading
    // 500 "required field \"kind\" not set" (SPEC §B B9). `name` here is the Application.
    return this.#req(
      "POST",
      `/api/v1/applications/${encodeURIComponent(name)}/resource/actions/v2`,
      {
        name,
        namespace: resource.namespace,
        resourceName: resource.name,
        version: resource.version,
        group: resource.group,
        kind: resource.kind,
        action,
      },
    );
  }
}
