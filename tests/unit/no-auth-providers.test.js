import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  freeProviders: {
    opencode: {
      id: "opencode",
      alias: "oc",
      name: "OpenCode Free",
      noAuth: true,
      modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
    },
    "mimo-free": {
      id: "mimo-free",
      alias: "mmf",
      name: "MiMo Code Free",
      noAuth: true,
      hidden: true,
    },
    ollama: {
      id: "ollama",
      alias: "ollama",
      name: "Ollama Cloud",
      noAuth: false,
    },
  },
}));

vi.mock("@/shared/constants/providers", () => ({
  FREE_PROVIDERS: mocks.freeProviders,
}));

import { fetchNoAuthModels, noAuthProviderEntries, withNoAuthProviders } from "@/lib/providers/noAuthProviders.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("no-auth provider catalog support", () => {
  it("lists only visible no-auth providers", () => {
    expect(noAuthProviderEntries().map((entry) => entry.id)).toEqual(["opencode"]);
  });

  it("adds a synthetic connection whose provider is the string id", () => {
    const connections = [{ id: "acc", provider: "ollama", isActive: true }];
    const result = withNoAuthProviders(connections);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(connections[0]);
    expect(result[1]).toMatchObject({
      id: "noauth:opencode",
      provider: "opencode",
      isActive: true,
      noAuth: true,
      providerSpecificData: {
        modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
      },
    });
    expect(typeof result[1].provider).toBe("string");
  });

  it("does not duplicate a provider that already has a connection", () => {
    const connections = [{ id: "acc", provider: "opencode", isActive: true }];
    expect(withNoAuthProviders(connections)).toHaveLength(1);
  });

  it("fetches and filters live free models through the modelsFetcher", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: "claude-opus-5" },
            { id: "muse-spark-1.3-contributor-free" },
            { id: "deepseek-v4-flash-free" },
            { id: "big-pickle" },
          ],
        }),
      }))
    );

    const models = await fetchNoAuthModels({
      url: "https://opencode.ai/zen/v1/models",
      type: "opencode-free",
    });

    expect(models.map((model) => model.id)).toEqual([
      "muse-spark-1.3-contributor-free",
      "big-pickle",
    ]);
  });

  it("fails open to an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    expect(await fetchNoAuthModels({ url: "https://x/models", type: "opencode-free" })).toEqual([]);
    expect(await fetchNoAuthModels(null)).toEqual([]);
  });
});
