// Model registry tests — V17 (config-time resolution, ⊥ network).
import assert from "assert/strict";
import { describe, it } from "node:test";
import { PROVIDER_KEYS, resolveModel } from "../src/models/registry.ts";

describe("resolveModel (V17)", () => {
  it("10 provider terdaftar", () => {
    assert.equal(PROVIDER_KEYS.length, 10);
  });

  it("mode A → string provider:model tanpa butuh env", () => {
    for (const p of ["openai", "anthropic", "bedrock", "ollama", "deepseek"] as const) {
      const m = resolveModel(p, "test-model");
      assert.equal(typeof m, "string");
      assert.equal(m, `${p}:test-model`);
    }
  });

  it("mode B compat → instance ChatOpenAI dengan baseURL benar", () => {
    process.env.OPENROUTER_API_KEY = "k-test";
    process.env.HF_TOKEN = "hf-test";
    const or = resolveModel("openrouter", "anthropic/claude-x") as { clientConfig?: { baseURL?: string } };
    assert.equal(or.clientConfig?.baseURL, "https://openrouter.ai/api/v1");
    const hf = resolveModel("huggingface", "meta-llama/L") as { clientConfig?: { baseURL?: string } };
    assert.equal(hf.clientConfig?.baseURL, "https://router.huggingface.co/v1");
    process.env.NGODEAI_API_KEY = "ng-test";
    const ng = resolveModel("ngodeai", "ngodeai/laguna-s-2.1-free") as { clientConfig?: { baseURL?: string } };
    assert.equal(ng.clientConfig?.baseURL, "https://llm.ngodeai.net/v1");
    // LM Studio lokal — ⊥ butuh env sama sekali
    const ls = resolveModel("lmstudio", "local-model") as { clientConfig?: { baseURL?: string } };
    assert.equal(ls.clientConfig?.baseURL, "http://localhost:1234/v1");
  });

  it("provider ber-key tanpa env → throw jelas di config-time", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ALIBABA_API_KEY;
    assert.throws(() => resolveModel("openrouter", "x"), /OPENROUTER_API_KEY/);
    assert.throws(() => resolveModel("alibaba-tongyi", "x"), /ALIBABA_API_KEY/);
  });

  it("provider tidak dikenal → throw", () => {
    assert.throws(() => resolveModel("opencode" as never, "x"), /tidak dikenal/);
  });
});
