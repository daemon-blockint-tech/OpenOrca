# kit-models — multi-model, multi-provider registry

Cites: SPEC §C (model provider), §V16, §V17, §T16. Grounding: `context/refs/research/deepagents_core.md`
(model resolusi: string `"provider:model"` via LangChain `initChatModel`, atau instance `BaseLanguageModel`
langsung — dicek per subagent lewat `SubAgent.model`).

## Klarifikasi: OpenCode ⊥ termasuk registry

Diminta: OpenAI, Anthropic, **OpenCode**, Ollama, LM Studio, HuggingFace, OpenRouter, AWS Bedrock, DeepSeek, Alibaba Tongyi.

Terverifikasi: **OpenCode bukan model provider** — dia AI coding agent terminal open-source (spt deepagents/Claude Code sendiri) yang *memanggil* 75+ provider lain (OpenAI, Anthropic, Gemini, Bedrock, Groq, OpenRouter, Ollama, dst) via kredensial user. Memasukkannya ke registry berarti OpenOrca memanggil agent lain sebagai "model" — salah lapis arsitektur (agent-ke-agent, bukan agent-ke-model). ∴ dikeluarkan dari registry. Kalau maksudnya lain (mis. wrap OpenCode sebagai `CompiledSubAgent`/`AsyncSubAgent` — pola nested pipeline di kit-workflow), itu keputusan terpisah, bukan bagian model registry.

## Registry — 9 provider

Deepagents resolve model 2 cara: **(A)** string `"provider:model"` → LangChain `initChatModel` (provider harus dikenali registry bawaan LangChain); **(B)** instance `BaseLanguageModel` langsung → dipakai utk endpoint OpenAI-compatible custom (baseURL) atau paket dedicated. Kolom "mode" menandai yang mana.

```
provider       | mode | paket                    | model contoh              | env credential
openai         | A    | @langchain/openai         | gpt-5.1, gpt-4o            | OPENAI_API_KEY
anthropic      | A    | @langchain/anthropic      | claude-sonnet-4-6          | ANTHROPIC_API_KEY
bedrock        | A    | @langchain/aws            | anthropic.claude-*         | AWS_ACCESS_KEY_ID/SECRET (+profile)
ollama         | A/B  | @langchain/ollama         | llama3.3, qwen2.5          | — (local, OLLAMA_BASE_URL opsional)
deepseek       | A    | @langchain/deepseek       | deepseek-chat, deepseek-r1 | DEEPSEEK_API_KEY
alibaba-tongyi | B    | @langchain/community      | qwen-max, qwen-plus        | ALIBABA_API_KEY (DashScope)
openrouter     | B    | @langchain/openai (compat)| openrouter/anthropic/... , meta-llama/*  | OPENROUTER_API_KEY
lmstudio       | B    | @langchain/openai (compat)| model lokal apa pun         | — (local, LMSTUDIO_BASE_URL)
huggingface    | B    | @langchain/openai (compat)| model apa pun di HF Hub    | HF_TOKEN
```

Mode B = **OpenAI-compatible baseURL** (bukan paket dedicated per-provider) — pola paling stabil utk endpoint yang mem-mirror OpenAI Chat Completions API. ⊥ ada paket resmi utk OpenRouter/LM Studio (mereka memang didesain drop-in OpenAI-compat); HuggingFace dipakai via **Inference Providers router** (`router.huggingface.co/v1`, OpenAI-compatible) — bukan `HuggingFaceInference` lama di `@langchain/community` yang cuma text-completion & lemah di tool-calling (kritikal krn deepagents butuh tool calling utk semua tool: `ontology_query`, `argocd_sync`, dst).

## Pola koneksi (2 mode, verbatim)

### Mode A — string shortcut (provider dikenal `initChatModel`)
```ts
createDeepAgent({ model: "anthropic:claude-sonnet-4-6" })
createDeepAgent({ model: "openai:gpt-5.1" })
createDeepAgent({ model: "bedrock:anthropic.claude-sonnet-4-6-v1:0" })
createDeepAgent({ model: "deepseek:deepseek-chat" })
createDeepAgent({ model: "ollama:qwen2.5-coder" })   // Ollama lokal juga bisa mode A
```

### Mode B — instance eksplisit (OpenAI-compatible baseURL)
```ts
import { ChatOpenAI } from "@langchain/openai"

const openrouterModel = new ChatOpenAI({
  model: "anthropic/claude-sonnet-4.5",
  apiKey: process.env.OPENROUTER_API_KEY,
  configuration: { baseURL: "https://openrouter.ai/api/v1" },
})

const lmstudioModel = new ChatOpenAI({
  model: "local-model-id",
  apiKey: "not-needed",                               // LM Studio ⊥ cek key
  configuration: { baseURL: process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1" },
})

const hfModel = new ChatOpenAI({
  model: "meta-llama/Llama-3.3-70B-Instruct",
  apiKey: process.env.HF_TOKEN,
  configuration: { baseURL: "https://router.huggingface.co/v1" },
})

createDeepAgent({ model: openrouterModel })            // instance, ⊥ string
```

### Mode B — paket dedicated (API shape beda, bukan OpenAI-compat)
```ts
import { ChatAlibabaTongyi } from "@langchain/community/chat_models/alibaba_tongyi"
const tongyiModel = new ChatAlibabaTongyi({ model: "qwen-max", alibabaApiKey: process.env.ALIBABA_API_KEY })
createDeepAgent({ model: tongyiModel })
```

## Registry module — abstraksi wajib (V17)

∀ provider baru didaftar di **satu tempat**: `packages/agents/src/models/registry.ts`. Tools/pipeline/subagents ⊥ pernah `new ChatOpenAI(...)` langsung — mereka minta model lewat `resolveModel(providerKey, modelId)`. Ini yang bikin swap-provider (§C model agnostic) & cross-model run (V16/T16) jadi 1 parameter, bukan refactor.

```ts
// packages/agents/src/models/registry.ts
type ProviderKey = "openai"|"anthropic"|"bedrock"|"ollama"|"deepseek"|"alibaba-tongyi"|"openrouter"|"lmstudio"|"huggingface"

function resolveModel(provider: ProviderKey, modelId: string): LanguageModelLike {
  switch (provider) {
    case "openai": case "anthropic": case "bedrock": case "deepseek": case "ollama":
      return `${provider}:${modelId}`                         // mode A — deepagents resolve sendiri
    case "openrouter":   return openAICompat(modelId, "https://openrouter.ai/api/v1", env.OPENROUTER_API_KEY)
    case "lmstudio":     return openAICompat(modelId, env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1", "not-needed")
    case "huggingface":  return openAICompat(modelId, "https://router.huggingface.co/v1", env.HF_TOKEN)
    case "alibaba-tongyi": return new ChatAlibabaTongyi({ model: modelId, alibabaApiKey: env.ALIBABA_API_KEY })
  }
}
```

## Cross-model harness (V16, T16)

Subagent spec (Hunt/Challenge/dsb) sudah punya field `model?` sendiri (`SubAgentBase.model`, deepagents_capabilities.md) — cross-model run = panggil `runPipeline` N kali dgn `resolveModel(provider, modelId)` berbeda per run, hasil di-union+dedup (kit-workflow §Model diversity). Metrik per (provider×model×workflow) disimpan sbg attribute di `agent-action` (kit-ontology) utk lacak coverage/validation-rate/cost/runtime/refusal/duplicate-rate.

## Acceptance criteria

1. `resolveModel` sukses utk 9 provider (unit test per provider, mock HTTP utk yang perlu network).
2. Ganti provider 1 subagent (mis. Hunt "authz" dari `anthropic` ke `deepseek`) ⊥ butuh ubah kode tool/pipeline (V17).
3. ⊥ ada `new Chat*(...)` di luar `packages/agents/src/models/` (lint/grep check, sama pola dgn acceptance criteria T18).
4. Provider tanpa API key (mis. LM Studio local) tetap resolve tanpa error auth di jalur non-network (config-time).
5. Run Hunt yang sama dgn 2 provider berbeda → 2 set finding tersimpan terpisah di graph, siap union (V16).
