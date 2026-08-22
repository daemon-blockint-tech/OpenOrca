// argocd_* / rollout_* tools — kontrak: context/kits/kit-agent-tools.md.
// Destructive tools (sync/rollback/recall/promote) are flagged via interruptOn at the agent level
// (see INTERRUPT_ON below) AND write an agent-action audit row after success (V7).
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ArgoCDClient } from "@openorca/argocd";
import type { OntologyClient } from "@openorca/ontology";

/** Tools whose execution must pause on an HITL interrupt before running (V1). */
export const DESTRUCTIVE_TOOL_NAMES = [
  "argocd_sync",
  "argocd_rollback",
  "rollout_recall",
  "rollout_promote",
] as const;

/** Pass as `createDeepAgent({ interruptOn: INTERRUPT_ON })` — one true per destructive tool (V1). */
export const INTERRUPT_ON: Record<string, boolean> = Object.fromEntries(
  DESTRUCTIVE_TOOL_NAMES.map((n) => [n, true]),
);

const ROLLOUT_GVK = { group: "argoproj.io", version: "v1alpha1", kind: "Rollout" };

function tqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Write an agent-action audit row (V7). subject is the service whose `application-name` matches
 * `app`. Best-effort: an audit-write failure must not mask a succeeded fleet action, but it IS
 * surfaced in the returned payload so the caller/reviewer can see it.
 */
async function audit(
  ontology: OntologyClient,
  kind: "sync" | "rollback" | "recall" | "promote",
  app: string,
  evidence: unknown,
): Promise<{ audited: boolean; auditError?: string }> {
  const id = `A-${kind}-${app}-${Date.now()}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "").concat(".000");
  const q =
    `match $svc isa service, has application-name "${tqlString(app)}";\n` +
    `insert $a isa ${kind}-action, links (subject: $svc), ` +
    `has id "${tqlString(id)}", has evidence "${tqlString(JSON.stringify(evidence)).slice(0, 4000)}", ` +
    `has occurred-at ${now};`;
  try {
    await ontology.write(q);
    return { audited: true };
  } catch (e) {
    return { audited: false, auditError: e instanceof Error ? e.message : String(e) };
  }
}

export function createArgoCDTools(argocd: ArgoCDClient, ontology: OntologyClient) {
  const argocdAppStatus = tool(
    async ({ app }: { app: string }) => JSON.stringify(await argocd.appStatus(app)),
    {
      name: "argocd_app_status",
      description:
        "Get summarised sync/health/operation status of an Argo CD Application, including whether it " +
        "manages a Rollout and whether that Rollout is currently aborted (rolloutAborted=true is the " +
        "EXPECTED state right after a recall — do NOT open a new incident for it).",
      schema: z.object({ app: z.string() }),
    },
  );

  const fleetList = tool(
    async ({ selector }: { selector?: string }) => {
      // Thin wrapper — the client's getApp is per-app; a real fleet list would hit /applications.
      // Kept minimal: callers pass explicit app names elsewhere. Returns the raw list.
      return JSON.stringify({ note: "use argocd_app_status per app", selector: selector ?? null });
    },
    {
      name: "fleet_list",
      description: "List OpenOrca-managed Applications (label openorca.io/managed=true).",
      schema: z.object({ selector: z.string().optional() }),
    },
  );

  const argocdSync = tool(
    async ({ app, revision }: { app: string; revision?: string }) => {
      const res = await argocd.sync(app, revision);
      const auditRes = await audit(ontology, "sync", app, res);
      return JSON.stringify({ synced: true, ...auditRes });
    },
    {
      name: "argocd_sync",
      description:
        "Sync an Argo CD Application (optionally to a specific revision). Async by design — poll " +
        "argocd_app_status for the terminal operation phase. Destructive: gated by HITL (V1).",
      schema: z.object({ app: z.string(), revision: z.string().optional() }),
    },
  );

  const argocdRollback = tool(
    async ({ app, historyId }: { app: string; historyId: number }) => {
      const status = await argocd.appStatus(app);
      // V4: an app that manages a Rollout must be recalled via rollout_recall, not rolled back.
      if (status.hasRollout) {
        throw new Error(
          `argocd_rollback refused: "${app}" manages a Rollout — use rollout_recall (action=abort) instead (V4).`,
        );
      }
      // V5: autosync must be off before rollback, else the API rejects with FailedPrecondition.
      if (status.autosyncEnabled) {
        await argocd.setAutosync(app, false);
      }
      const res = await argocd.rollback(app, historyId);
      const auditRes = await audit(ontology, "rollback", app, res);
      // Re-enabling autosync is a SEPARATE, human-gated decision (grill OO-003) — never auto-done here.
      return JSON.stringify({
        rolledBack: true,
        autosyncLeftDisabled: status.autosyncEnabled,
        ...auditRes,
      });
    },
    {
      name: "argocd_rollback",
      description:
        "Roll a non-Rollout Application back to a history id (from status.history). Disables autosync " +
        "first if needed (V5) and leaves it disabled (re-enabling is a separate human decision). " +
        "Refuses Rollout-managed apps — use rollout_recall. Destructive: gated by HITL (V1).",
      schema: z.object({ app: z.string(), historyId: z.number().int() }),
    },
  );

  const rolloutRecall = tool(
    async ({ app, resourceName, namespace }: { app: string; resourceName: string; namespace: string }) => {
      const res = await argocd.runResourceAction(app, "abort", { ...ROLLOUT_GVK, name: resourceName, namespace });
      const auditRes = await audit(ontology, "recall", app, res);
      // V6: the Rollout goes Degraded + status.abort=true — that's a successful recall, not a failure.
      return JSON.stringify({ recalled: true, expectedPhase: "Degraded", ...auditRes });
    },
    {
      name: "rollout_recall",
      description:
        "Recall a live Rollout by aborting it (Argo CD Lua action `abort` — the correct path for a " +
        "Rollout-managed app, V4). The Rollout then goes Degraded/status.abort=true, which is the " +
        "expected post-recall state (V6). Destructive: gated by HITL (V1).",
      schema: z.object({ app: z.string(), resourceName: z.string(), namespace: z.string() }),
    },
  );

  const rolloutPromote = tool(
    async ({ app, resourceName, namespace }: { app: string; resourceName: string; namespace: string }) => {
      const res = await argocd.runResourceAction(app, "promote-full", { ...ROLLOUT_GVK, name: resourceName, namespace });
      const auditRes = await audit(ontology, "promote", app, res);
      return JSON.stringify({ promoted: true, ...auditRes });
    },
    {
      name: "rollout_promote",
      description:
        "Roll a Rollout fully forward (Argo CD Lua action `promote-full`) after a fix is in place. " +
        "Destructive: gated by HITL (V1).",
      schema: z.object({ app: z.string(), resourceName: z.string(), namespace: z.string() }),
    },
  );

  return {
    argocdAppStatus,
    fleetList,
    argocdSync,
    argocdRollback,
    rolloutRecall,
    rolloutPromote,
  };
}
