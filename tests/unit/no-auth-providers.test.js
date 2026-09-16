import assert from "node:assert/strict";
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

import { noAuthProviderEntries, withNoAuthProviders } from "@/lib/providers/noAuthProviders.js";

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

    assert.equal(result.length, 2);
    assert.equal(result[0], connections[0]);
    assert.equal(result[1].id, "noauth:opencode");
    assert.equal(result[1].provider, "opencode");
    assert.equal(result[1].isActive, true);
    assert.equal(result[1].noAuth, true);
    assert.equal(typeof result[1].provider, "string");
  });

  it("does not duplicate a provider that already has a connection", () => {
    const connections = [{ id: "acc", provider: "opencode", isActive: true }];
    assert.equal(withNoAuthProviders(connections).length, 1);
  });

  it("keeps the input array untouched", () => {
    const connections = [];
    withNoAuthProviders(connections);
    assert.equal(connections.length, 0);
  });
});
