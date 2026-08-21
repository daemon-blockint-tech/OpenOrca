# infra-decisions — checkpointer, dev cluster, sandbox (riset 2026-08-21)

Sumber: workflow riset 3-agent paralel + 1 fact-check pass, web-grounded, skor 1-5 per kriteria
(simple/scalable/maintainable/usable/secure). Keputusan lengkap → SPEC §C, V17-V19; detail → kit-models,
kit-sandboxes, project-structure.md.

## Checkpointer → PostgresSaver

```
kandidat    | s c m u sec | fatal flaw
MemorySaver  | 5 1 3 5 2   | hilang saat restart proses → V1 gagal by construction
SqliteSaver  | 4 2 3 4 3   | single-writer-file, LangGraph docs: dev-only
PostgresSaver| 3 5 4 4 4   | ⊥ ada — direkomendasikan resmi produksi
RedisSaver   | 3 4 3 3 3   | durability butuh tuning AOF/fsync manual; layanan stateful ke-3
MongoDBSaver | 3 4 3 3 3   | ⊥ ada win jelas vs Postgres utk kasus ini
```
Semua paket resmi `langchain-ai/langgraphjs` monorepo, rilis 2026-08-19 (bukan community/stale). Gap jujur:
⊥ ada encryption-at-rest built-in di paket JS manapun (beda dgn Python `EncryptedSerializer`) — enkripsi
harus di layer deployment Postgres.

## Dev cluster → kind

```
kandidat          | s c m u sec | fatal flaw
kind                | 5 5 5 4 3 | —
k3d                  | 5 5 4 4 3 | ⊥ pre-installed GitHub Actions runner
minikube             | 3 3 5 5 4 | 3-4x RAM/cluster, lambat utk multi-cluster
Rancher Desktop      | 3 2 3 4 4 | 1 cluster/instance, GUI-only ⊥ CI
Docker Desktop k8s   | 4 1 3 4 3 | 1 cluster/instance — gagal keras topologi ApplicationSet
```
kind vs k3d: keduanya nyaris identik performa; kind menang krn dipakai default di dokumentasi ArgoCD +
pre-installed CI runner + subproject resmi kubernetes-sigs.

## Sandbox hunter → Docker+gVisor (default), Firecracker/microsandbox (upgrade)

```
kandidat          | provider resmi | isolasi         | self-host | s c m u sec
docker+gvisor       | ⊥ custom      | container(gVisor)| Y        | 5 4 5 5 3→4
firecracker          | ⊥ custom      | hardware-VM      | Y        | 2 4 3 2 5
vercel sandbox        | ⊥ custom      | microVM          | N        | 3 4 3 3 5
daytona                | @langchain/daytona | container | Y (frozen)| 3 4 2 4 3
modal                    | @langchain/modal   | container | N        | 4 5 4 4 3
deno                       | @langchain/deno    | microVM(SaaS)| N    | 3 3 3 3 3
```
Koreksi penting dari asumsi awal: **Deno provider ⊥ isolasi permission-flag lokal** — dia wrap Deno Deploy
hosted Sandbox SDK (SaaS, region terbatas). **Daytona OSS diarsipkan Juni 2026** — self-host jadi frozen
fork. **LocalShellBackend memang ada di deepagentsjs** (dikonfirmasi source langsung, bukan cuma dok
Python) — zero isolasi, dikeluarkan dari role hunter (V13/V18) tapi sah dipakai di luar scope eksekusi kode
pihak ketiga.

## Yang TIDAK diputuskan riset ini

- TypeDB dev password (preferensi murni, grill OO-001 masih terbuka).
- Encryption-at-rest checkpointer (catatan operasional, bukan blocker — layer Postgres deployment).
- Firecracker/microsandbox: rekomendasi arah, BUKAN implementasi siap pakai — T20 minta prototipe dulu.
