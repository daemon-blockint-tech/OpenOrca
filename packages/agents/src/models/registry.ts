// Model registry — SATU tempat instansiasi model (SPEC V17, kit-models.md).
// ⊥ ada `new Chat*(...)` di luar file ini; tools/pipeline/subagents minta lewat resolveModel.
import { ChatOpenAI } from "@langchain/openai";

export const PROVIDER_KEYS = [
  "openai",
  "anthropic",
  "bedrock",
  "ollama",
  "deepseek",
  "alibaba-tongyi",
  "openrouter",
  "lmstudio",
  "huggingface",
  "ngodeai",
] as const;

export type ProviderKey = (typeof PROVIDER_KEYS)[number];

/** Mode A = string "provider:model" (deepagents/LangChain initChatModel resolve sendiri). */
const MODE_A: readonly ProviderKey[] = ["openai", "anthropic", "bedrock", "ollama", "deepseek"];

/** OpenAI-compatible endpoint (mode B) — pola paling stabil utk provider non-native. */
function openAICompat(modelId: string, baseURL: string, apiKey: string | undefined, keyEnv: string): ChatOpenAI {
  if (!apiKey) {
    throw new Error(`resolveModel: env ${keyEnv} belum di-set untuk provider ini`);
  }
  return new ChatOpenAI({ model: modelId, apiKey, configuration: { baseURL } });
}

/**
 * Resolve (provider, modelId) → LanguageModelLike yang diterima createDeepAgent/SubAgent.model.
 * Config-time saja — ⊥ network call di sini; auth error baru muncul saat invoke.
 */
export function resolveModel(provider: ProviderKey, modelId: string): string | ChatOpenAI {
  if (!PROVIDER_KEYS.includes(provider)) {
    throw new Error(`resolveModel: provider tidak dikenal "${provider}" — daftar di kit-models.md`);
  }
  if (MODE_A.includes(provider)) {
    return `${provider}:${modelId}`;
  }
  switch (provider) {
    case "openrouter":
      return openAICompat(modelId, "https://openrouter.ai/api/v1", process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY");
    case "lmstudio":
      // Local — API key tidak dicek servernya.
      return new ChatOpenAI({
        model: modelId,
        apiKey: "not-needed",
        configuration: { baseURL: process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1" },
      });
    case "huggingface":
      return openAICompat(modelId, "https://router.huggingface.co/v1", process.env.HF_TOKEN, "HF_TOKEN");
    case "ngodeai":
      return openAICompat(modelId, "https://llm.ngodeai.net/v1", process.env.NGODEAI_API_KEY, "NGODEAI_API_KEY");
    case "ngodeai":
      return openAICompat(modelId, "https://llm.ngodeai.net/v1", process.env.NGODEAI_API_KEY, "NGODEAI_API_KEY");
    case "alibaba-tongyi": {
      const key = process.env.ALIBABA_API_KEY;
      if (!key) throw new Error("resolveModel: env ALIBABA_API_KEY belum di-set");
      // Paket dedicated (@langchain/community) — import lazy supaya dep berat hanya
      // dibayar kalau provider ini benar2 dipakai.
      return (async () => {
        const mod = await import("@langchain/community/chat_models/alibaba_tongyi");
        return new mod.ChatAlibabaTongyi({ model: modelId, alibabaApiKey: key });
      })() as unknown as ChatOpenAI;
    }
    default: {
      const exhaustive: never = provider;
      throw new Error(`resolveModel: provider ${String(exhaustive)} tak tertangani`);
    }
  }
}
