import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/constants/models", () => ({
  PROVIDER_ID_TO_ALIAS: { "opencode-go": "ocg", anthropic: "anthropic" },
  PROVIDER_MODELS: { ocg: [{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code" }] },
}));

vi.mock("@/shared/constants/providers", () => ({
  getProviderAlias: (id) => (id === "opencode-go" ? "ocg" : id),
  getProviderByAlias: (alias) => {
    if (alias === "ocg") {
      return { alias: "ocg", name: "OpenCode Go", color: "#E87040", textIcon: "OC" };
    }
    if (alias === "anthropic") {
      return { alias: "anthropic", name: "Anthropic", color: "#D97757", textIcon: "A" };
    }
    return null;
  },
  AI_PROVIDERS: {},
}));

import {
  buildCombosPayload,
  buildManifestPayload,
  buildPoolsPayload,
  buildProvidersPayload,
  outputAliasForConnection,
  parseKinds,
  summarizePool,
} from "@/lib/bridge/discovery.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

const settings = {
  fallbackStrategy: "fill-first",
  providerStrategies: { "opencode-go": { fallbackStrategy: "round-robin" } },
};

const connections = [
  { id: "c1", provider: "opencode-go", isActive: true, testStatus: "active" },
  {
    id: "c2",
    provider: "opencode-go",
    isActive: true,
    testStatus: "active",
    rateLimitedUntil: "2026-09-15T12:05:00.000Z",
  },
  { id: "c3", provider: "opencode-go", isActive: true, testStatus: "unavailable" },
  { id: "c4", provider: "opencode-go", isActive: false },
  {
    id: "c5",
    provider: "anthropic",
    isActive: true,
    testStatus: "active",
    modelLock_claude: "2026-09-15T12:10:00.000Z",
    lastTested: "2026-09-15T11:00:00.000Z",
  },
  { id: "c6", provider: "gemini", isActive: false },
];

const models = [
  { id: "ocg/kimi-k2.7-code", object: "model", owned_by: "ocg" },
  { id: "ocg/not-in-registry", object: "model", owned_by: "ocg" },
  { id: "anthropic/claude-sonnet-4", object: "model", owned_by: "anthropic" },
  { id: "gemini/pro", object: "model", owned_by: "gemini" },
  { id: "my-combo", object: "model", owned_by: "combo" },
];

describe("bridge discovery", () => {
  it("resolves the output alias with prefix > alias > provider id", () => {
    expect(outputAliasForConnection({ provider: "opencode-go" })).toBe("ocg");
    expect(
      outputAliasForConnection({
        provider: "openai-compatible-node1",
        providerSpecificData: { prefix: "my-node" },
      })
    ).toBe("my-node");
    expect(outputAliasForConnection({ provider: "unknown-provider" })).toBe("unknown-provider");
  });

  it("summarizes a pool as counts only", () => {
    const pool = summarizePool(connections, "opencode-go", settings, NOW);
    expect(pool).toEqual({
      connections: 3,
      ready: 1,
      cooling: 1,
      unavailable: 1,
      locks: 0,
      last_activity: null,
      strategy: "round-robin",
    });
    expect(JSON.stringify(pool)).not.toContain("c1");
  });

  it("counts model locks and honours the global strategy fallback", () => {
    const pool = summarizePool(connections, "anthropic", settings, NOW);
    expect(pool.connections).toBe(1);
    expect(pool.locks).toBe(1);
    expect(pool.ready).toBe(1);
    expect(pool.strategy).toBe("fill-first");
    expect(pool.last_activity).toBe("2026-09-15T11:00:00.000Z");
  });

  it("groups models under active providers only and drops combos", () => {
    const providers = buildProvidersPayload({
      models,
      connections,
      settings,
      now: NOW,
    });

    expect(providers.map((provider) => provider.id)).toEqual(["opencode-go", "anthropic"]);

    const ocg = providers.find((provider) => provider.id === "opencode-go");
    expect(ocg.alias).toBe("ocg");
    expect(ocg.name).toBe("OpenCode Go");
    expect(ocg.models.map((model) => model.id)).toEqual([
      "ocg/kimi-k2.7-code",
      "ocg/not-in-registry",
    ]);
    expect(ocg.models[0].name).toBe("Kimi K2.7 Code");
    expect(ocg.models[1].name).toBeUndefined();
    expect(ocg.pool.connections).toBe(3);

    const serialized = JSON.stringify(providers);
    expect(serialized).not.toContain("gemini/pro");
    expect(serialized).not.toContain('"c1"');
  });

  it("builds flat pool rows and includes model_count only when models are supplied", () => {
    const fast = buildPoolsPayload({ connections, settings, now: NOW });
    expect(fast).toHaveLength(2);
    expect(fast[0]).toMatchObject({
      object: "pool",
      provider: "opencode-go",
      alias: "ocg",
      connections: 3,
      ready: 1,
      cooling: 1,
      strategy: "round-robin",
    });
    expect(fast[0]).not.toHaveProperty("model_count");

    const enriched = buildPoolsPayload({ models, connections, settings, now: NOW });
    expect(enriched.find((pool) => pool.alias === "ocg").model_count).toBe(2);
    expect(enriched.find((pool) => pool.alias === "anthropic").model_count).toBe(1);
  });

  it("marks combo models available based on active providers", () => {
    const combos = buildCombosPayload({
      combos: [{ id: "combo-1", name: "free", kind: null, models: ["ocg/kimi-k2.7-code", "gemini/pro"] }],
      connections,
    });

    expect(combos[0]).toMatchObject({
      object: "combo",
      id: "combo-1",
      name: "free",
      model_count: 2,
      available_model_count: 1,
    });
    expect(combos[0].models).toEqual([
      { id: "ocg/kimi-k2.7-code", available: true },
      { id: "gemini/pro", available: false },
    ]);
  });

  it("assembles a manifest with the three modes in one payload", () => {
    const manifest = buildManifestPayload({
      models,
      connections,
      combos: [{ id: "combo-1", name: "free", models: ["ocg/kimi-k2.7-code"] }],
      settings,
      now: NOW,
    });

    expect(manifest.object).toBe("9router.bridge");
    expect(manifest.modes.map((mode) => mode.id)).toEqual(["providers", "combos", "pools"]);
    expect(manifest.counts).toEqual({
      providers: 2,
      pools: 2,
      combos: 1,
      models: 5,
    });
  });

  it("validates requested kinds", () => {
    expect(parseKinds(null)).toEqual(["llm"]);
    expect(parseKinds("image,tts")).toEqual(["image", "tts"]);
    expect(parseKinds("bogus")).toEqual(["llm"]);
  });
});
