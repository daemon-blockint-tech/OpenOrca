# OpenOrca

Open-source vulnerability operations: loop **Detect → Validate → Remediate → Resolve → Learn** dengan human in the lead — orkestrasi agent AI di atas stack terbuka:

| Peran | Komponen |
|---|---|
| Agent runtime | [deepagentsjs](https://github.com/langchain-ai/deepagentsjs) (TypeScript) |
| Context graph / ontology | [TypeDB v3](https://github.com/typedb/typedb) via HTTP v1 |
| Fleet deploy & recall | [Argo CD](https://github.com/argoproj/argo-cd) + [Argo Rollouts](https://github.com/argoproj/argo-rollouts) |

## Struktur

```
SPEC.md                  # kontrak: goal, invariants (V*), tasks (T*), bugs — sumber kebenaran
ARCHITECTURE.md          # arsitektur high-level: komponen, alur loop, trust boundaries
FORMAT.md                # encoding SPEC.md
context/
├── refs/
│   ├── research/        # riset source-level fondasi stack (10 laporan)
│   ├── principles.md    # 5 insight yang membentuk desain
│   └── adoption.md      # 9-step sequence membangun pipeline
├── kits/                # kit-ontology · kit-agent-tools · kit-fleet · kit-workflow
├── plans/               # project-structure (foldering + pseudocode) + plan per wave
└── impl/STATUS.md       # tracking implementasi
factory/
├── specs/{inbox,active,archive}/   # assembly line: spec = task, folder = state
└── {prompts,runs,reviews}/         # artefak dispatch (audit trail)
```

## Alur kerja

1. Spec masuk `factory/specs/inbox/` — grill gate dijawab manusia dulu.
2. `loop-factory dispatch --agent claude --stage` → implement acceptance criteria → verifikasi.
3. `loop-factory review <id>` → lulus → `archive --accepted`.
4. Pelajaran → backprop ke `SPEC.md` §B/§V dan kits.

Keputusan produk selalu manusia; agent hanya implement + verifikasi.

## License

Apache-2.0
