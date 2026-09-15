import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUsageHistory: vi.fn(),
  getRequestDetailsInRange: vi.fn(),
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/usageDb", () => ({
  getUsageHistory: mocks.getUsageHistory,
  getRequestDetailsInRange: mocks.getRequestDetailsInRange,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
}));

vi.mock("@/shared/constants/providers", () => ({
  getProviderByAlias: (id) => (id === "opencode-go" ? { name: "OpenCode Go" } : undefined),
  AI_PROVIDERS: {},
}));

import { GET } from "@/app/api/usage/routing/route.js";

const history = [
  { timestamp: "2026-09-14T11:00:00.000Z", provider: "opencode-go", model: "mimo-v2.5", connectionId: "conn-a", cost: 0.01, status: "ok", tokens: { prompt_tokens: 1000, completion_tokens: 100 } },
  { timestamp: "2026-09-14T11:05:00.000Z", provider: "opencode-go", model: "mimo-v2.5", connectionId: "conn-b", cost: 0.01, status: "ok", tokens: { prompt_tokens: 2000, completion_tokens: 200 } },
  { timestamp: "2026-09-14T11:06:00.000Z", provider: "opencode-go", model: "minimax-m3", connectionId: "conn-b", cost: 0, status: "429", tokens: { prompt_tokens: 100, completion_tokens: 0 } },
];

const details = [
  {
    provider: "opencode-go",
    routing: {
      provider: "opencode-go",
      attempts: [
        { connectionId: "conn-a", name: "sub 1", status: 429, action: "fallback", cooldownMs: 2000 },
        { connectionId: "conn-b", name: "sub 2", status: 502, action: "fallback", cooldownMs: 30000 },
      ],
      selected: { connectionId: "conn-c", name: "sub 3", reason: "round-robin" },
      combo: null,
    },
  },
  {
    provider: "opencode-go",
    routing: {
      combo: {
        name: "my-combo",
        kind: "combo",
        strategy: "fallback",
        models: [
          { model: "opencode-go/mimo-v2.5", status: "failed:429" },
          { model: "opencode-go/deepseek-flash", status: "success" },
        ],
      },
      attempts: [{ connectionId: "conn-a", name: "sub 1", status: 400, action: "capability", cooldownMs: 1000 }],
    },
  },
];

async function callRoute(query = "") {
  const response = await GET(new Request(`http://localhost/api/usage/routing${query}`));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsageHistory.mockResolvedValue(history);
  mocks.getRequestDetailsInRange.mockResolvedValue(details);
  mocks.getProviderConnections.mockResolvedValue([
    { id: "conn-a", name: "sub 1", testStatus: "active" },
    { id: "conn-b", name: "sub 2", testStatus: "unavailable", rateLimitedUntil: "2099-01-01T00:00:00.000Z", modelLock_mimo: "2099-01-01T00:00:00.000Z" },
  ]);
});

describe("GET /api/usage/routing", () => {
  it("aggregates providers with a per-connection breakdown", async () => {
    const { status, body } = await callRoute("?period=7d");
    expect(status).toBe(200);
    expect(body.providers).toHaveLength(1);
    const provider = body.providers[0];
    expect(provider).toMatchObject({ provider: "opencode-go", name: "OpenCode Go", requests: 3, failures: 1 });
    expect(provider.tokens).toBe(1000 + 100 + 2000 + 200 + 100);

    const byConn = Object.fromEntries(provider.connections.map((c) => [c.connectionId, c]));
    expect(byConn["conn-a"]).toMatchObject({ name: "sub 1", requests: 1, failures: 0 });
    expect(byConn["conn-b"]).toMatchObject({ name: "sub 2", requests: 2, failures: 1 });
    expect(byConn["conn-b"].testStatus).toBe("unavailable");
    expect(byConn["conn-b"].cooldownUntil).toBe("2099-01-01T00:00:00.000Z");
    expect(byConn["conn-b"].lockCount).toBe(1);
  });

  it("aggregates redirects by action and provider", async () => {
    const { body } = await callRoute("?period=7d");
    expect(body.redirects.total).toBe(3);
    expect(body.redirects.tracedRequests).toBe(2);
    const actions = Object.fromEntries(body.redirects.byAction.map((a) => [a.action, a.count]));
    expect(actions).toEqual({ fallback: 2, capability: 1 });
    expect(body.redirects.byProvider[0]).toMatchObject({ provider: "opencode-go", count: 3 });
  });

  it("aggregates combos with per-model ok/failed counts", async () => {
    const { body } = await callRoute("?period=7d");
    expect(body.combos).toHaveLength(1);
    expect(body.combos[0]).toMatchObject({ name: "my-combo", kind: "combo", strategy: "fallback", attempts: 1 });
    const models = Object.fromEntries(body.combos[0].models.map((m) => [m.model, m]));
    expect(models["opencode-go/mimo-v2.5"]).toMatchObject({ ok: 0, failed: 1 });
    expect(models["opencode-go/deepseek-flash"]).toMatchObject({ ok: 1, failed: 0 });
  });

  it("returns empty aggregates when nothing is recorded", async () => {
    mocks.getUsageHistory.mockResolvedValue([]);
    mocks.getRequestDetailsInRange.mockResolvedValue([]);
    const { body } = await callRoute("?period=all");
    expect(body.providers).toEqual([]);
    expect(body.redirects.total).toBe(0);
    expect(body.combos).toEqual([]);
  });
});
