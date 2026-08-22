// DockerGvisorSandbox — BaseSandbox via docker exec/cp (V18, kit-sandboxes.md §1).
// Container HARUS dibuat lewat createHunterContainer() — hardening flags bukan opsional:
//   --runtime=runsc (gVisor; kernel isolation utk repo pihak ketiga) --read-only
//   --security-opt no-new-privileges --cap-drop ALL --memory --cpus --network none
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaseSandbox } from "deepagents";
import type { ExecuteResponse, FileDownloadResponse, FileUploadResponse } from "deepagents";

const execFileP = promisify(execFile);

export interface HunterContainerOptions {
  name: string;
  image: string;
  /** Default true — V18. false HANYA untuk dev lokal tanpa runsc terpasang (log warning). */
  requireRunsc?: boolean;
  memory?: string;
  cpus?: string;
}

/**
 * Buat + start container hunter yang hardened. Idempotent per nama.
 * Return container id untuk resolveSandbox / DockerGvisorSandbox.
 */
export async function createHunterContainer(opts: HunterContainerOptions): Promise<string> {
  const requireRunsc = opts.requireRunsc ?? true;

  // Runtime check dulu supaya error-nya jelas, bukan "runtime not found" dari daemon.
  const { stdout } = await execFileP("docker", ["info", "--format", "{{json .Runtimes}}"]);
  const hasRunsc = stdout.includes("runsc");
  if (requireRunsc && !hasRunsc) {
    throw new Error(
      "createHunterContainer: runtime runsc (gVisor) tidak tersedia di docker ini — " +
        "wajib untuk hunter (V18). Install gVisor atau set requireRunsc=false khusus dev.",
    );
  }
  const runtimeArgs = hasRunsc ? ["--runtime", "runsc"] : [];
  if (!hasRunsc) console.warn("[sandbox] WARNING: jalan TANPA gVisor — dev only, ⊥ produksi");

  await execFileP("docker", [
    "run", "-d",
    "--name", opts.name,
    ...runtimeArgs,
    "--read-only",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    `--memory=${opts.memory ?? "512m"}`,
    `--cpus=${opts.cpus ?? "1.0"}`,
    "--network=none",
    // workdir tulis-baru di tmpfs — rootfs read-only
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs", "/work:rw,noexec,nosuid,size=256m",
    "-w", "/work",
    opts.image,
    "sleep", "infinity",
  ]).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already in use")) return { stdout: "" }; // idempotent
    throw err;
  });
  const { stdout: id } = await execFileP("docker", ["inspect", "-f", "{{.Id}}", opts.name]);
  return id.trim();
}

/** Runner injectable untuk test — default execFile("docker"). `input` dikirim ke stdin. */
export type DockerRunner = (args: string[], input?: string) => Promise<{ stdout: string }>;

function quoteShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export class DockerGvisorSandbox extends BaseSandbox {
  #containerId: string;
  #run: DockerRunner;

  constructor(containerId: string, run: DockerRunner = async (args) => execFileP("docker", args)) {
    super();
    this.#containerId = containerId;
    this.#run = run;
  }

  get id(): string {
    return this.#containerId;
  }

  async execute(command: string): Promise<ExecuteResponse> {
    try {
      const { stdout } = await this.#run(["exec", this.#containerId, "sh", "-c", command]);
      return { output: stdout, exitCode: 0, truncated: false };
    } catch (err: unknown) {
      // execFile melempar pada exit code ≠ 0 — itu hasil eksekusi sah, bukan kegagalan infra.
      const e = err as { stdout?: string; stderr?: string; code?: number | undefined };
      if (typeof e?.code === "number") {
        return { output: `${e.stdout ?? ""}${e.stderr ?? ""}`, exitCode: e.code, truncated: false };
      }
      throw err;
    }
  }
  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = [];
    for (const [path, content] of files) {
      try {
        // Tulis via stdin exec — hindari file temp di host.
        await this.#run(
          ["exec", "-i", this.#containerId, "sh", "-c",
            `mkdir -p "$(dirname ${quoteShell(path)})" && cat > ${quoteShell(path)}`],
          new TextDecoder().decode(content),
        );
        results.push({ path, error: null });
      } catch {
        results.push({ path, error: "permission_denied" });
      }
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];
    for (const path of paths) {
      try {
        const res = await this.#run([
          "exec", this.#containerId, "sh", "-c",
          `if [ -f ${quoteShell(path)} ]; then cat ${quoteShell(path)}; else echo __NOT_FOUND__; fi`,
        ]);
        if (res.stdout.trim() === "__NOT_FOUND__") {
          results.push({ path, content: null, error: "file_not_found" });
        } else {
          results.push({ path, content: new TextEncoder().encode(res.stdout), error: null });
        }
      } catch {
        results.push({ path, content: null, error: "permission_denied" });
      }
    }
    return results;
  }
}
