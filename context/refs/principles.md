# principles — 5 insight yang membentuk OpenOrca

Sumber: strategi produk (2026-08). Bahasa asli dipertahankan; pemetaan komponen → stack OpenOrca.

## 1. Model ≠ program security-review. Harness = produknya.

Model butuh harness: software, instruksi, tools, **akses data**, kontrol — yang mengorganisasi kerja antar agent, membatasi akses tiap agent, menyimpan bukti, merutekan hasil *tervalidasi* ke engineer. Harness mengoordinasi banyak agent & model lewat **structured workflows yang di-tune per kebutuhan: kedalaman analitis, efisiensi operasional, atau kelas vulnerability spesifik**.
→ OpenOrca: **deepagents** sebagai harness + orchestration layer (teks sumber mengosongkan nama komponen — di sini deepagents). Tuning per-workload = kombinasi subagent spec (model & tools berbeda per kelas vuln) + harness profiles (`registerHarnessProfile`) + model string `"provider:model"` per subagent. Ref: `kit-agent-tools` §Wiring, ARCHITECTURE §Komponen.

## 2. Kualitas harness = konteks organisasi yang bisa dia pakai.

Model lebih berguna saat paham relasi antar service, letak trust boundary, konfigurasi ter-deploy, kesimpulan review sebelumnya, siapa owner.
→ OpenOrca: **TypeDB** — lineage ontologis lintas source, finding, keputusan, remediasi. Ref: `kit-ontology` (relation `dependency`, `ownership`, `resolution`, fungsi `blast`).

## 3. Konteks organisasi = alpha; wajib tetap di bawah kontrol org.

Data, model, keputusan, aksi, lingkungan deploy, akumulasi pengetahuan ∈ alpha unik organisasi; ⊥ terekspos eksternal. Sovereignty atas pipeline AI security → intelijen yang dihasilkan compound balik ke sistem sendiri, bukan ke pihak ketiga yang bisa repackage/resell/erode posisi kompetitif.
→ OpenOrca: seluruh context store self-hosted (TypeDB, checkpointer, memory, factory audit trail). Ter-encode di SPEC §C (sovereignty).

## 4. Remediasi = bottleneck baru.

Kecepatan identifikasi vulnerability sudah melcompat; bottleneck bergeser ke: seberapa cepat fix ter-deploy di lingkungan luas & heterogen.
→ OpenOrca: **ArgoCD + Rollouts** — jalur mapan utk deliver fix terverifikasi lintas fleet (ApplicationSet, recall `abort`, roll-forward `promote-full`, gate analysis). Ref: `kit-fleet`.

## 5. Model & harness akan terus membaik; yang durable = proses ter-governed + infrastruktur di sekitarnya.

Infrastruktur menentukan apakah program security org ikut membaik saat model membaik.
→ OpenOrca: **TypeDB** meng-compound context & memory, **deepagents** meng-orkestrasi agent yang swappable (model = `"provider:model"` string), **ArgoCD** menerapkan fix lintas estate. Framework tetap; model & threat berganti.

---

Pemetaan insight → artefak repo:

```
insight|artefak
1|kit-agent-tools, ARCHITECTURE (HITL, tools layer), V1 V9
2|kit-ontology, V7
3|§C sovereignty
4|kit-fleet, V4 V5 V10
5|§C model-agnostic, ARCHITECTURE §Deployment
```
