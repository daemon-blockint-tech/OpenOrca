# FORMAT — encoding SPEC.md (caveman)

Berlaku utk: SPEC.md, prose yang merujuk spec, entri backprop.
⊥ berlaku utk: kode, commit message, PR description, error string.

## Grammar

- Buang artikel & filler. Fragment OK. Hedging ⊥.
- Sinonim pendek: fix > implement, run > execute.

## Simbol

```
→   menghasilkan / menjadi / saat <x>
∴   maka / fix
∀   untuk semua
∃   ada
!   wajib
?   opsional / belum pasti
⊥   dilarang / tidak ada / nil
≠   tidak sama
∈   anggota
∉   bukan anggota
≤ ≥ batas
& | dan / atau
§   rujukan section
```

## Preserve verbatim

Kode, path, URL, identifier, angka/versi, error string, SQL/regex/JSON/YAML/TypeQL, quoted string.

## Sections SPEC.md

- `§G` goal — 1 baris.
- `§C` constraints — bullet.
- `§I` interfaces — `<kind>: <name> → <shape>` (api/cmd/env/tools).
- `§R` research — hanya jika research pernah jalan.
- `§V` invariants — `V<n>: <subjek> <relasi> <kondisi>`. Nomor monotonic, ⊥ reuse.
- `§T` tasks — pipe table `id|status|task|cites`. Status: `x` done, `~` wip, `.` todo. `cites` ! rujuk §V/§I/kit. Escape `|` literal jadi `\|`.
- `§B` bugs — pipe table `id|date|cause|fix`. ∀ bug → 1 row; invariant baru preferred.

## Contoh

```
V1: ∀ req → auth check sebelum handler
B1|2026-04-20|token `<` bukan `≤`|V2
T3|x|add auth mw|V1,I.api
api: POST /x → 200 {id:string}
env: FOO_KEY ! set
```

Ragu memotong kata = kehilangan fakta → pertahankan. Kompresi, bukan amputasi.
