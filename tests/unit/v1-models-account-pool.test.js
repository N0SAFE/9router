import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(),
}));

import { buildModelsList } from "@/app/api/v1/models/route.js";
import { parseModel } from "open-sse/services/model.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
});

describe("/v1/models account pool", () => {
  it("exposes the union of per-account model lists under one provider prefix", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "acc-a",
        provider: "opencode-go",
        isActive: true,
        providerSpecificData: { enabledModels: ["gpt-5.6-luna"] },
      },
      {
        id: "acc-b",
        provider: "opencode-go",
        isActive: true,
        providerSpecificData: { enabledModels: ["mimo-v2.5"] },
      },
    ]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    // Public catalog uses the provider's established UI alias (ocg); both
    // ocg/<model> and opencode-go/<model> route to the same pool.
    expect(ids).toContain("ocg/gpt-5.6-luna");
    expect(ids).toContain("ocg/mimo-v2.5");
    expect(ids.some((id) => id.includes("acc-a") || id.includes("acc-b"))).toBe(false);

    expect(parseModel("opencode-go/gpt-5.6-luna")).toMatchObject({
      provider: "opencode-go",
      model: "gpt-5.6-luna",
    });
    expect(parseModel("ocg/gpt-5.6-luna")).toMatchObject({
      provider: "opencode-go",
      model: "gpt-5.6-luna",
    });
  });

  it("keeps the registry catalog when at least one account is unrestricted", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "acc-a",
        provider: "opencode-go",
        isActive: true,
        providerSpecificData: { enabledModels: ["gpt-5.6-luna"] },
      },
      {
        id: "acc-b",
        provider: "opencode-go",
        isActive: true,
        providerSpecificData: {},
      },
    ]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    // The unrestricted account must not have its registry models hidden by the
    // restricted sibling.
    expect(ids.filter((id) => id.startsWith("ocg/")).length).toBeGreaterThan(1);
    expect(ids).toContain("ocg/gpt-5.6-luna");
  });
});
