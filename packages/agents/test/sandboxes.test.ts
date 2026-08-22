// Sandbox tests — DockerGvisorSandbox dgn runner injectable (⊥ butuh docker daemon).
import assert from "assert/strict";
import { describe, it } from "node:test";
import { DockerGvisorSandbox, type DockerRunner } from "../src/sandboxes/docker.ts";
import { SANDBOX_KEYS } from "../src/sandboxes/registry.ts";

const ok = (stdout: string) => async () => ({ stdout });

describe("DockerGvisorSandbox", () => {
  it("execute membungkus command via docker exec + quoting shell aman", async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return { stdout: "hello" };
    };
    const sb = new DockerGvisorSandbox("cid123", runner);
    const res = await sb.execute("cat '/work/a b.txt'; echo $HOME");
    assert.equal(res.exitCode, 0);
    assert.equal(res.output, "hello");
    assert.equal(calls[0]?.[0], "exec");
    assert.equal(calls[0]?.[1], "cid123");
    // command utuh sebagai 1 arg setelah sh -c — ⊥ dipecah shell host
    assert.equal(calls[0]?.[2], "sh");
    assert.equal(calls[0]?.[3], "-c");
  });

  it("exit code ≠ 0 dari command → ExecuteResponse sah, ⊥ throw infra", async () => {
    const failing: DockerRunner = async () => {
      throw Object.assign(new Error("boom"), { code: 7, stdout: "out", stderr: "err" });
    };
    const sb = new DockerGvisorSandbox("c1", failing);
    const res = await sb.execute("false");
    assert.equal(res.exitCode, 7);
    assert.match(res.output, /out|err/);
  });

  it("downloadFiles: file ada → content; tidak ada → error file_not_found", async () => {
    let n = 0;
    const runner: DockerRunner = async () => ({ stdout: n++ === 0 ? "data" : "__NOT_FOUND__" });
    const sb = new DockerGvisorSandbox("c2", runner);
    const [a, b] = await sb.downloadFiles(["/x", "/y"]);
    assert.equal(a?.error, null);
    assert.equal(new TextDecoder().decode(a?.content), "data");
    assert.equal(b?.error, "file_not_found");
  });

  it("uploadFiles mengirim content lewat stdin exec", async () => {
    const inputs: string[] = [];
    const runner: DockerRunner = async (_args, input) => {
      inputs.push(input ?? "");
      return { stdout: "" };
    };
    const sb = new DockerGvisorSandbox("c3", runner);
    const [r] = await sb.uploadFiles([["/tmp/f.txt", new TextEncoder().encode("payload")]]);
    assert.equal(r?.error, null);
    assert.match(inputs[0] ?? "", /payload/);
  });
});

describe("sandbox registry (V18)", () => {
  it("hanya docker-gvisor yang terimplementasi; lainnya throw eksplisit T20", async () => {
    assert.ok(SANDBOX_KEYS.includes("docker-gvisor"));
    for (const k of SANDBOX_KEYS.filter((k) => k !== "docker-gvisor")) {
      await assert.rejects(
        // resolveSandbox butuh docker daemon utk docker-gvisor; key lain throw sebelum itu.
        import("../src/sandboxes/registry.ts").then((m) => m.resolveSandbox(k as never, { name: "x", image: "y" })),
        /T20|docker-gvisor/,
      );
    }
  });
});
