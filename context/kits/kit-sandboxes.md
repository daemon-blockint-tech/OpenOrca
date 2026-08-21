# kit-sandboxes — sandbox execution registry (hunter subagents)

Cites: SPEC §V13, §V18, §T20. Grounding: `context/refs/research/deepagents_capabilities.md` (kontrak `BaseSandbox`),
riset infra 2026-08-21 (checkpointer/cluster/sandbox, web-grounded + fact-check pass).

## Konteks ancaman

Hunter subagent clone + execute repo pihak ketiga (scan, build step, scanner tooling) — sisi paling tajam
dari batas V13 (least-privilege) di seluruh pipeline: build script berbahaya di repo yang di-scan bisa
dapat akses host penuh kalau sandbox lemah. ∴ **isolation strength dominan** dalam pemilihan, sovereignty
(§C) sekunder tapi tetap preferensi kuat.

Kontrak deepagents (verbatim, terverifikasi source `libs/deepagents/src/backends/sandbox.ts`): abstract
`BaseSandbox` cuma wajib `execute(command)`, `uploadFiles`, `downloadFiles`, `id` — semua op file (ls/read/
grep/glob) diturunkan otomatis dari `execute()`. Provider resmi di monorepo deepagentsjs: `@langchain/daytona`,
`@langchain/modal`, `@langchain/deno` (dicek via GitHub API `libs/providers/`, cuma 3 + `node-vfs`+`quickjs`
yang bukan sandbox eksekusi umum).

## Registry — 7 kandidat, skor 1-5 (simple/scalable/maintainable/usable/secure)

```
kandidat          | provider resmi | isolasi              | self-host | s c m u sec | catatan singkat
docker+gvisor      | ⊥ (custom)     | container (gVisor)    | Y         | 5 4 5 5 3→4 | DEFAULT — lihat di bawah
firecracker microVM| ⊥ (custom)     | hardware-VM (KVM)      | Y         | 2 4 3 2 5   | upgrade path, no ready SDK
microsandbox       | ⊥ (custom)     | microVM (libkrun)      | Y         | ~4 4 4 4 5  | alternatif turnkey Firecracker
vercel sandbox     | ⊥ (custom)     | microVM (Firecracker)  | N         | 3 4 3 3 5   | isolasi kuat, platform-only
daytona            | @langchain/daytona | container (opsional Kata/VM) | Y (frozen fork) | 3 4 2 4 3 | OSS diarsipkan Jun 2026
modal              | @langchain/modal   | container (gVisor)    | N         | 4 5 4 4 3   | SaaS-only, gVisor "not for fully untrusted"
deno                | @langchain/deno   | microVM (Deno Deploy) | N         | 3 3 3 3 3   | SaaS-only, region terbatas (ams/ord)
```

## 1. Docker + gVisor (self-hosted, custom `BaseSandbox`) — **default v1**

Termurah dibangun: seluruh permukaan `BaseSandbox` = `execute→docker exec`, `upload/download→docker cp`,
`id→container id`. Docker matang, tooling debug standar (`logs/inspect/exec -it`). **Caveat nyata**: runc
polos berbagi kernel host — container-escape (kelas CVE-2025-23266) = kompromi host penuh, ⊥ ada lapis
kedua. ∴ **wajib hardening**, bukan opsional: rootless Docker, seccomp/AppArmor profile, `--security-opt
no-new-privileges`, resource limits, dan **runtime class gVisor (`runsc`)** sbg lapis isolasi tambahan
(drop-in, menaikkan `secure` dari 3→4). Vanilla `docker exec` tanpa hardening ⊥ cukup utk build script hostile.

```ts
// packages/agents/src/sandboxes/docker.ts
class DockerGvisorSandbox extends BaseSandbox {
  constructor(private containerId: string) { super() }
  get id() { return this.containerId }
  async execute(command: string) {
    // container HARUS dibuat dgn: --runtime=runsc --security-opt no-new-privileges --read-only
    //   --memory=<limit> --cpus=<limit> --network=<scoped-or-none> (rootless docker daemon)
    return sh(`docker exec ${this.containerId} sh -c ${shellQuote(command)}`)
  }
  async uploadFiles(files) { /* docker cp per file */ }
  async downloadFiles(paths) { /* docker cp per file */ }
}
```

## 2. Firecracker microVM — upgrade path

Isolasi terkuat yang self-hosted (hardware-virtualization KVM, teknologi yang sama dgn AWS Lambda/Fargate).
⊥ ada SDK ber-bentuk `execute/upload/download` siap pakai — perlu dibangun di atas `firecracker-containerd`
(containerd task exec + vsock/mounted volume). Investasi rekayasa nyata (`simple:2, usable:2`), tapi ini
target saat skala Hunt fleet atau severity ancaman melebihi isolasi container. **microsandbox** (Apache-2.0,
libkrun, self-hosted-only, CLI/SDK siap pakai, boot <200ms) = alternatif turnkey yang lebih murah dibangun
drpd Firecracker langsung — prototipe ini dulu sebelum DIY Firecracker penuh.

## 3. Cloud vendor (Daytona / Modal / Deno) — dokumentasi, BUKAN default

- **Daytona**: provider resmi ada, tapi OSS-nya **diarsipkan Juni 2026** (pindah closed-source) — self-host
  jadi frozen fork yang ⊥ ikut upstream fix. Risiko maintainability jangka panjang.
- **Modal**: performa/skala terbaik (20k container concurrent), tapi **SaaS-only** (⊥ BYOC sama sekali) dan
  isolasi gVisor-nya sendiri diakui vendor "tidak sekuat utk fully untrusted execution" — persis threat model hunter.
- **Deno**: provider resmi ADA tapi (koreksi penting) ⊥ isolasi permission-flag lokal seperti umum diasumsikan
  — source `libs/providers/deno/src/sandbox.ts` konfirmasi dia wrap **Deno Deploy hosted Sandbox SDK**
  (`DENO_DEPLOY_TOKEN`, region terbatas Amsterdam/Chicago, memory cap 768MB-4096MB). SaaS-only jg.

Ketiganya boleh jadi backend tambahan **kalau** org menerima tradeoff sovereignty utk compute (§C literal
cuma scope context/state store, bukan compute) — daftarkan lewat pola registry yang sama (§Wiring), ⊥ default.

## LocalShellBackend — dikeluarkan utk hunter (V13), TERKONFIRMASI real di JS

Koreksi thd riset awal: `LocalShellBackend` **memang ada di deepagentsjs** (`libs/deepagents/src/backends/
local-shell.ts`, dikonfirmasi baca source langsung sesi ini — bukan cuma dokumentasi Python). Zero isolasi
by design (`FilesystemBackend` + `execute` host tanpa batas, `{timeout=120s, maxOutputBytes=100_000}`).
∴ ⊥ dipakai role hunter (V13/V18). Tetap sah dipakai di luar scope eksekusi kode pihak ketiga — mis. dev
lokal / tooling internal yang ⊥ menyentuh repo untrusted.

## Wiring — registry pattern (sama seperti kit-models)

```ts
// packages/agents/src/sandboxes/registry.ts
type SandboxKey = "docker-gvisor" | "firecracker" | "microsandbox" | "vercel" | "daytona" | "modal" | "deno"

function resolveSandbox(key: SandboxKey, opts): BaseSandbox {
  switch (key) {
    case "docker-gvisor": return new DockerGvisorSandbox(opts.containerId)
    case "firecracker":   return new FirecrackerSandbox(opts)        // T20 — belum dibangun, placeholder
    case "microsandbox":  return new MicrosandboxSandbox(opts)       // T20 — evaluasi prototipe
    case "vercel":        return new VercelSandbox(opts)             // custom, opsional (§C tradeoff)
    case "daytona":       return new DaytonaSandbox(opts)            // @langchain/daytona
    case "modal":         return new ModalSandbox(opts)              // @langchain/modal
    case "deno":          return new DenoSandbox(opts)               // @langchain/deno
  }
}
```

Hunter subagent (kit-workflow §Hunt) default: `resolveSandbox("docker-gvisor", ...)`. ⊥ hardcode `new
Docker*(...)` di tools/pipeline (pola sama dgn V17 model registry).

## Acceptance criteria

1. `DockerGvisorSandbox` lulus `@langchain/sandbox-standard-tests` (conformance suite deepagents).
2. Container hunter dibuat dgn `--runtime=runsc`, rootless, `--read-only`, resource limit ter-set — verifikasi via `docker inspect`.
3. Uji escape sederhana (mis. baca `/proc/1/root` host) gagal dari dalam sandbox.
4. Ganti sandbox 1 subagent (docker-gvisor → daytona) ⊥ butuh ubah kode tool (pola registry, spt V17).
5. Firecracker/microsandbox: minimal prototipe boot+exec sukses sebelum diklaim "upgrade path siap".
