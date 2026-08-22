// Sandbox registry — SATU tempat resolusi backend eksekusi hunter (V18, kit-sandboxes.md).
// ⊥ hardcode `new DockerGvisorSandbox(...)` di tools/pipeline — minta lewat resolveSandbox.
import { BaseSandbox } from "deepagents";
import { createHunterContainer, DockerGvisorSandbox, type HunterContainerOptions } from "./docker.ts";

export const SANDBOX_KEYS = [
  "docker-gvisor",
  "firecracker",
  "microsandbox",
  "vercel",
  "daytona",
  "modal",
  "deno",
] as const;

export type SandboxKey = (typeof SANDBOX_KEYS)[number];

export function resolveSandbox(key: SandboxKey, opts: HunterContainerOptions): Promise<BaseSandbox> {
  switch (key) {
    case "docker-gvisor":
      return createHunterContainer(opts).then((id) => new DockerGvisorSandbox(id));
    // T20 — upgrade path, belum dibangun. Eksplisit throw, ⊥ silent fallback ke isolasi lebih lemah.
    case "firecracker":
    case "microsandbox":
    case "vercel":
    case "daytona":
    case "modal":
    case "deno":
      return Promise.reject(
        new Error(`resolveSandbox: "${key}" belum diimplementasikan (T20) — pakai docker-gvisor`),
      );
    default: {
      const exhaustive: never = key;
      return Promise.reject(new Error(`resolveSandbox: key tak dikenal ${String(exhaustive)}`));
    }
  }
}
