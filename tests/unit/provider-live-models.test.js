import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providers: {
    ollama: {
      id: "ollama",
      alias: "ollama",
      name: "Ollama Cloud",
      modelsFetcher: { url: "https://ollama.com/api/tags", type: "ollama-tags", auth: "bearer" },
    },
    opencode: {
      id: "opencode",
      alias: "oc",
      name: "OpenCode Free",
      noAuth: true,
      modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
    },
    plain: {
      id: "plain",
      alias: "plain",
      name: "No Fetcher",
    },
  },
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: mocks.providers,
}));

import {
  fetchConnectionModels,
  modelsFetcherFor,
  parseFetcherPayload,
} from "@/lib/providers/liveModels.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider live model lists", () => {
  it("resolves the registry modelsFetcher", () => {
    expect(modelsFetcherFor("ollama")).toMatchObject({ type: "ollama-tags", auth: "bearer" });
    expect(modelsFetcherFor("plain")).toBeNull();
  });

  it("parses Ollama /api/tags payloads", () => {
    const models = parseFetcherPayload("ollama-tags", {
      models: [
        { name: "gpt-oss:120b", model: "gpt-oss:120b" },
        { name: "minimax-m3", model: "minimax-m3" },
        { name: null, model: null },
      ],
    });
    assert.deepEqual(models, [
      { id: "gpt-oss:120b", name: "gpt-oss:120b" },
      { id: "minimax-m3", name: "minimax-m3" },
    ]);
  });

  it("parses OpenCode free payloads through the shared filter", () => {
    const models = parseFetcherPayload("opencode-free", {
      data: [
        { id: "claude-opus-5" },
        { id: "muse-spark-1.3-contributor-free" },
        { id: "deepseek-v4-flash-free" },
        { id: "big-pickle" },
      ],
    });
    assert.deepEqual(models.map((model) => model.id), [
      "muse-spark-1.3-contributor-free",
      "big-pickle",
    ]);
  });

  it("parses the OpenRouter catalog with free flags", () => {
    const models = parseFetcherPayload("openrouter-all", {
      data: [
        {
          id: "openai/gpt-5",
          name: "GPT-5",
          pricing: { prompt: "0.001", completion: "0.002" },
          context_length: 400000,
          architecture: { output_modalities: ["text"] },
        },
        {
          id: "meta/llama-free",
          name: "Llama Free",
          pricing: { prompt: "0", completion: "0" },
          context_length: 131072,
          architecture: { output_modalities: ["text"] },
        },
        {
          id: "openai/text-embedding-3",
          pricing: { prompt: "0", completion: "0" },
          context_length: 8191,
          architecture: { output_modalities: ["embeddings"] },
        },
      ],
    });
    assert.deepEqual(models, [
      { id: "openai/gpt-5", name: "GPT-5", free: false, contextLength: 400000 },
      { id: "meta/llama-free", name: "Llama Free", free: true, contextLength: 131072 },
    ]);
  });

  it("fetches with the connection's own bearer token and caches the result", async () => {
    const seen = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        seen.push({ url, auth: init?.headers?.Authorization });
        return {
          ok: true,
          json: async () => ({ models: [{ name: "gpt-oss:120b", model: "gpt-oss:120b" }] }),
        };
      })
    );

    const connection = { id: "conn-ollama", provider: "ollama", apiKey: "ollama-key" };
    const first = await fetchConnectionModels("ollama", connection);
    const second = await fetchConnectionModels("ollama", connection);

    assert.deepEqual(first, [{ id: "gpt-oss:120b", name: "gpt-oss:120b" }]);
    assert.deepEqual(second, first);
    assert.equal(seen.length, 1, "second call is served from cache");
    assert.equal(seen[0].url, "https://ollama.com/api/tags");
    assert.equal(seen[0].auth, "Bearer ollama-key");
  });

  it("fails open to an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    const result = await fetchConnectionModels("ollama", {
      id: "conn-fail",
      provider: "ollama",
      apiKey: "bad",
    });
    assert.deepEqual(result, []);
  });

  it("returns [] for providers without a fetcher", async () => {
    assert.deepEqual(await fetchConnectionModels("plain", { id: "x" }), []);
  });
});
