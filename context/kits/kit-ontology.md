# kit-ontology — schema TypeDB v3 OpenOrca

Cites: SPEC §V2, §V3, §V6, §V7. Referensi teknikal: `context/refs/research/typedb_typeql.md`, `typedb_drivers.md`.

Kit = implementation-agnostic terhadap client; schema TypeQL di bawah verbatim, apply via schema transaction (`POST /v1/query` one-shot dgn `commit: true`, atau tx `schema` eksplisit).

## Schema

```typeql
define
  attribute id value string;
  attribute name value string;
  attribute email value string;
  attribute repo-url value string;
  attribute cluster-name value string;
  attribute namespace-name value string;
  attribute image-ref value string;
  attribute revision value string;
  attribute version-str value string;
  attribute cve-id value string;
  attribute severity value string @values("critical", "high", "medium", "low", "info");
  attribute exploitability value string @values("confirmed", "likely", "unlikely", "not-exploitable", "unknown");
  attribute finding-state value string @values("open", "triaged", "awaiting-approval", "remediating", "resolved", "dismissed");
  attribute verdict value string @values("true-positive", "false-positive", "wont-fix");
  attribute action-kind value string @values("sync", "rollback", "recall", "promote", "patch", "scan", "judge");
  attribute cwe-id value string;
  attribute entry-point value string;
  attribute sink value string;
  attribute exploit-path value string;
  attribute remediation value string;
  attribute summary value string;
  attribute evidence value string;
  attribute occurred-at value datetime;

  entity engineer
    owns id @key, owns name, owns email @unique,
    plays ownership:owner, plays approval:approver;

  entity service
    owns id @key, owns name, owns repo-url,
    plays ownership:owned,
    plays dependency:dependent, plays dependency:dependee,
    plays deployment-of:subject,
    plays impact:target;

  entity package
    owns id @key, owns name, owns version-str,
    plays dependency:dependee, plays impact:target;

  entity deployment
    owns id @key, owns cluster-name, owns namespace-name, owns image-ref, owns revision, owns occurred-at,
    plays deployment-of:instance, plays impact:target;

  entity vulnerability
    owns id @key, owns cve-id @unique, owns severity, owns summary,
    plays manifestation:pattern;

  entity finding
    owns id @key, owns severity, owns exploitability, owns finding-state,
    owns verdict @card(0..1), owns cwe-id @card(0..),
    owns entry-point @card(0..1), owns sink @card(0..1), owns exploit-path @card(0..1),
    owns summary, owns evidence, owns remediation @card(0..1), owns occurred-at,
    plays manifestation:instance, plays impact:source,
    plays resolution:problem, plays approval:subject,
    plays correlation:canonical, plays correlation:duplicate;

  entity agent-action
    owns id @key, owns action-kind, owns evidence, owns occurred-at,
    plays resolution:fix, plays approval:subject;

  relation ownership relates owner, relates owned @card(1..);
  relation dependency relates dependent, relates dependee;
  relation deployment-of relates instance, relates subject;
  relation manifestation relates pattern @card(0..1), relates instance;
  relation impact relates source, relates target @card(1..);
  relation resolution relates problem, relates fix;
  relation correlation relates canonical, relates duplicate @card(0..);
  relation approval relates approver, relates subject;
```

## Functions (reasoning — pengganti rules v2)

Rekursi dieksekusi dgn tabling (SCC) → terminate di dependency siklik. ⊥ negasi/agregasi dalam siklus (StratificationViolation).

```typeql
define
fun blast($s: service) -> { service }:
match
  { dependency (dependee: $s, dependent: $mid); let $out in blast($mid); } or
  { dependency (dependee: $s, dependent: $out); };
return { $out };

fun owner-of($s: service) -> { engineer }:
match
  ownership (owner: $e, owned: $s);
return { $e };

fun open-findings($s: service) -> { finding }:
match
  impact (source: $f, target: $s);
  $f isa finding, has finding-state "open";
return { $f };
```

## Query kanonik (dipakai tools)

```typeql
# triage: blast radius + owner utk 1 finding
match
  $f isa finding, has id "F-123";
  impact (source: $f, target: $svc);
  let $hit in blast($svc);
  let $eng in owner-of($hit);
fetch {
  "service": $hit.name,
  "owner": $eng.email
};

# learn writeback: verdict
match $f isa finding, has id "F-123";
update $f has verdict "false-positive", has finding-state "dismissed";

# audit: catat aksi agent (V7)
insert
  $a isa agent-action, has id "A-456", has action-kind "recall",
    has evidence "{...json argocd response...}", has occurred-at 2026-08-21T00:00:00;
```

## Acceptance criteria

1. Schema apply sukses ke db `openorca` (one-shot `POST /v1/query`, tx schema) → `answerType: "ok"`.
2. Insert service A→B→C→A (siklus) → `blast(A)` return {A,B,C}, terminate. (bukti tabling jalan)
3. `open-findings` + `reduce count` → jumlah benar; hasil >10k di-reduce di TypeQL, ⊥ 206 bocor ke agent (V2).
4. ∀ attribute ber-`@values` menolak nilai di luar enum → error annotation, bukan data korup.
5. `owner-of` di service tanpa ownership → hasil kosong, ⊥ error.
6. Dua finding entry-point+sink sama → dedup insert 1 `correlation` (canonical=id terkecil); jalankan 2x → idempotent (⊥ duplikat relation).
7. Attribute `cwe-id` @card(0..) → 1 finding boleh map ke banyak CWE; unified finding memuat exploit-path+severity+cwe-id+remediation.

## Catatan

- IID TypeDB internal (hex `0x1e…`); identitas lintas-sistem pakai attribute `id` @key (konvensi: `SVC-*, F-*, A-*, CVE-*`).
- Ubah schema = schema tx → blokir semua write sesaat; jalankan di jendela deploy.
- `verdict` @card(0..1): finding belum di-triage tidak punya verdict.
