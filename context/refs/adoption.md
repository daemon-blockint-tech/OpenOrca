# adoption — sequence membangun pipeline security agentic

Panduan praktis membangun pipeline security agentic: 9 langkah → dipetakan ke artefak OpenOrca.

```
# | langkah                                  | artefak OpenOrca                          | status
1 | Software inventory: repo, service, deps,  | kit-ontology (service/dependency/          | §T13
  | owner, deployed version, runtime          | ownership/deployment) = Foundation         |
2 | Mulai code-review bounded (finding ke      | kit-workflow §Hunt (target sempit dulu);   | §T8
  | code path spesifik, dicek engineer)        | evidence standard = finding.evidence       |
3 | Harness terkontrol: scoped agents, batasi | kit-workflow §Hunt/§Challenge; deepagents  | §T8,T14
  | tools+kredensial per stage, preserve       | permissions per-subagent, judge independen,| V1,V12,
  | evidence, challenge, dedup sebelum engineer| dedup source→sink                          | V13,V14
4 | Evaluasi banyak model + repeated runs;     | kit-workflow §Model diversity; lacak metrik| §T16
  | lacak coverage/validation-rate/cost/       | coverage, validation-rate, cost, runtime,  | V16
  | runtime/refusal/dup-rate                   | refusal, duplicate-rate                    |
5 | Retain keputusan: finding, false-positive, | kit-ontology (verdict, finding-state,      | §T11
  | reachability, accepted-risk, mitigasi, fix | correlation); suppression run berikutnya   | V7,V15
  | di sistem ber-lineage                      |                                            |
6 | Context sovereign: kepemilikan atas value  | SPEC §C sovereignty                        | §C
  | yang diciptakan; ⊥ terekspos eksternal     |                                            |
7 | Shared workflow security + product eng:    | §T17 — HITL surface (V1) + routing owner   | §T17
  | inspect evidence, add context, validasi    | (ownership); ⊥ antrean security terpisah   | V12
  | severity, assign owner, approve remediasi  |                                            |
8 | Sambung fix terverifikasi ke delivery      | kit-fleet — ArgoCD/Rollouts: release,      | §T6,T10
  | normal (release/deploy/health/rollback)    | deploy, health, rollback controls sama     |
9 | Definisi sukses benar: bukan panjang       | SPEC §C (success = verified risk turun,    | §C
  | daftar finding — tapi verified risk turun  | fix cepat/andal/efisien)                   |
  | di software ter-deploy, fix cepat/andal    |                                            |
```

## Baru dari langkah ini (belum ada sebelum)

- Metrik evaluasi model (langkah 4) → §T16: coverage, validation-rate, cost, runtime, refusal, duplicate-rate per (model × workflow).
- Shared engineer review surface (langkah 7) → §T17: satu tempat security+product engineer, ⊥ antrean terpisah.
- Definisi sukses (langkah 9) → §C: outcome = verified risk turun, bukan volume finding.

Konsep sovereignty → SPEC §C. ⊥ dependency teknis eksternal.
