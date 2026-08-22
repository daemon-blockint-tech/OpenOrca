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
    return this.#req(
      "POST",
      `/api/v1/applications/${encodeURIComponent(name)}/resource/actions/v2` +
        `?resourceName=${encodeURIComponent(resource.name)}` +
        `&namespace=${encodeURIComponent(resource.namespace)}` +
        `&group=${encodeURIComponent(resource.group)}` +
        `&kind=${encodeURIComponent(resource.kind)}` +
        `&version=${encodeURIComponent(resource.version)}`,
      { action, resourceName: resource.name, namespace: resource.namespace },
    );
  }
}
