import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
  handleBypassRequest: vi.fn(() => null),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
  getProjectIdForConnection: vi.fn(async () => null),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: mocks.handleAntigravityQuotaError,
  clearAntigravityStrikes: mocks.clearAntigravityStrikes,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleFusionChat,
  detectRequiredCapabilities: mocks.detectRequiredCapabilities,
}));

vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: mocks.augmentModelsWithCapacityAdapter,
  withCapacityAdapterStripping: mocks.withCapacityAdapterStripping,
  getActiveAdapterStrategy: mocks.getActiveAdapterStrategy,
}));

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: mocks.handleBypassRequest,
}));

vi.mock("@/lib/headroom/detect", () => ({
  DEFAULT_HEADROOM_URL: "http://127.0.0.1:9/headroom",
}));

vi.mock("@/lib/pxpipe/loader.js", () => ({
  getTransform: vi.fn(async () => null),
}));

vi.mock("@/lib/pxpipe/events.js", () => ({
  appendPxpipeEvent: vi.fn(),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mocks.getProjectIdForConnection,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  line: vi.fn(),
  errorLine: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

import { clearAccountPoolCache } from "open-sse/services/accountPool.js";
import { handleChat } from "@/sse/handlers/chat.js";

const SETTINGS = {
  requireApiKey: false,
  ccFilterNaming: false,
  comboStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
};

/**
 * Fake the credential store: accounts are tried in priority order, exclusion
 * sets and simulated model locks remove accounts, and an all-locked pool
 * reports allRateLimited exactly like auth.js does.
 */
function registerAccounts(accounts) {
  const locks = new Map();
  const selections = [];
  const excludeSnapshots = [];

  mocks.getProviderCredentials.mockImplementation(async (_provider, excludeIds) => {
    const exclude = excludeIds instanceof Set ? new Set(excludeIds) : new Set();
    excludeSnapshots.push(exclude);
    const now = Date.now();
    const available = accounts.filter((a) => !exclude.has(a.id) && (locks.get(a.id) || 0) <= now);

    if (available.length === 0) {
      const expiries = accounts.map((a) => locks.get(a.id) || 0).filter((t) => t > now);
      if (expiries.length === 0) return null;
      return {
        allRateLimited: true,
        retryAfter: new Date(Math.min(...expiries)).toISOString(),
        retryAfterHuman: "reset after 30s",
        lastError: "rate limit exceeded",
      };
    }

    const chosen = available[0];
    selections.push(chosen.id);
    return {
      connectionId: chosen.id,
      connectionName: chosen.id,
      authType: "apikey",
      apiKey: `key-${chosen.id}`,
      providerSpecificData: {},
      _connection: { backoffLevel: 0 },
    };
  });

  mocks.markAccountUnavailable.mockImplementation(async (connectionId, _status, _error, _provider, _model, resetsAtMs) => {
    locks.set(connectionId, resetsAtMs && resetsAtMs > Date.now() ? resetsAtMs : Date.now() + 30_000);
    return { shouldFallback: true, cooldownMs: 30_000 };
  });

  return { locks, selections, excludeSnapshots };
}

/**
 * Script chatCore outcomes in order. Each entry: { ok:true } or
 * { ok:false, status, error }. Records which account served each attempt.
 */
function scriptResponses(responses) {
  const used = [];
  const args = [];
  const queue = [...responses];

  mocks.handleChatCore.mockImplementation(async (chatArgs) => {
    const connectionId = chatArgs.credentials.connectionId;
    used.push(connectionId);
    args.push(chatArgs);

    const spec = queue.shift() || { ok: true };
    if (spec.ok !== false) {
      if (chatArgs.onRequestSuccess) await chatArgs.onRequestSuccess();
      return {
        success: true,
        response: new Response(JSON.stringify({ ok: true, account: connectionId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }
    return {
      success: false,
      status: spec.status,
      error: spec.error,
      response: new Response(JSON.stringify({ error: { message: spec.error } }), {
        status: spec.status,
        headers: { "Content-Type": "application/json" },
      }),
    };
  });

  return { used, args };
}

function invokeChat({ model = "opencode-go/gpt-5.6-luna", headers = {}, body = {} } = {}) {
  const payload = { messages: [{ role: "user", content: "hi" }], ...body, model };
  const request = new Request("http://localhost:20128/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const clientRawRequest = {
    endpoint: "/v1/chat/completions",
    body: payload,
    headers: Object.fromEntries(request.headers.entries()),
  };
  return handleChat(request, clientRawRequest);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAccountPoolCache();
  mocks.getSettings.mockResolvedValue({ ...SETTINGS });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockResolvedValue({ provider: "opencode-go", model: "gpt-5.6-luna" });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.handleAntigravityQuotaError.mockResolvedValue(null);
  mocks.updateProviderCredentials.mockResolvedValue(undefined);
  mocks.handleBypassRequest.mockReturnValue(null);
});

describe("generic provider account pool", () => {
  it("single account: one upstream attempt, response returned", async () => {
    registerAccounts([{ id: "acc-a" }]);
    const chat = scriptResponses([{ ok: true }]);

    const res = await invokeChat();

    expect(res.status).toBe(200);
    expect((await res.json()).account).toBe("acc-a");
    expect(chat.used).toEqual(["acc-a"]);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("multiple accounts: first success means the second is never contacted", async () => {
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    const chat = scriptResponses([{ ok: true }]);

    const res = await invokeChat();

    expect(res.status).toBe(200);
    expect(chat.used).toEqual(["acc-a"]);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("429 on the first account rotates to the second with the same model", async () => {
    const ctx = registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    const chat = scriptResponses([
      { ok: false, status: 429, error: "rate limit exceeded" },
      { ok: true },
    ]);

    const res = await invokeChat();

    expect(res.status).toBe(200);
    expect((await res.json()).account).toBe("acc-b");
    expect(chat.used).toEqual(["acc-a", "acc-b"]);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "acc-a", 429, "rate limit exceeded", "opencode-go", "gpt-5.6-luna", undefined,
    );
    // Second selection excluded the cooling-down account.
    expect(ctx.excludeSnapshots[1].has("acc-a")).toBe(true);
  });

  it("all accounts exhausted returns the standard unavailable response", async () => {
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }, { id: "acc-c" }]);
    const chat = scriptResponses([
      { ok: false, status: 429, error: "quota exceeded" },
      { ok: false, status: 429, error: "rate limit exceeded" },
      { ok: false, status: 429, error: "quota exceeded" },
    ]);

    const res = await invokeChat();

    expect(chat.used).toEqual(["acc-a", "acc-b", "acc-c"]);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.error.message).toMatch(/quota exceeded|rate limit/i);
  });

  it("returns limit reached from the session cache when durable locks are absent", async () => {
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    // No durable lock is written: only the in-memory session cache remembers.
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 30_000 });
    const chat = scriptResponses([
      { ok: false, status: 429, error: "rate limit exceeded" },
      { ok: false, status: 429, error: "rate limit exceeded" },
    ]);

    const res = await invokeChat();

    expect(chat.used).toEqual(["acc-a", "acc-b"]);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("all-account capability failure surfaces the upstream error, not a retry-after (session cache only)", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode-go", model: "nope" });
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 30_000 });
    const chat = scriptResponses([
      { ok: false, status: 400, error: "The model `nope` does not exist or you do not have access to it." },
      { ok: false, status: 400, error: "The model `nope` does not exist or you do not have access to it." },
    ]);

    const res = await invokeChat({ model: "opencode-go/nope", headers: { "x-session-id": "cap-all" } });

    expect(chat.used).toEqual(["acc-a", "acc-b"]);
    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("all-account capability failure surfaces the upstream error even with durable locks", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode-go", model: "nope" });
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    const chat = scriptResponses([
      { ok: false, status: 400, error: "Model `nope` is not supported" },
      { ok: false, status: 400, error: "Model `nope` is not supported" },
    ]);

    const res = await invokeChat({ model: "opencode-go/nope", headers: { "x-session-id": "cap-all-locked" } });

    expect(chat.used).toEqual(["acc-a", "acc-b"]);
    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect((await res.json()).error.message).toContain("not supported");
  });

  it("passes an arbitrary future model upstream unchanged", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode-go", model: "future-test-model" });
    registerAccounts([{ id: "acc-a" }]);
    const chat = scriptResponses([{ ok: true }]);

    const res = await invokeChat({ model: "opencode-go/future-test-model" });

    expect(res.status).toBe(200);
    expect(chat.args[0].modelInfo).toEqual({ provider: "opencode-go", model: "future-test-model" });
    expect(chat.args[0].body.model).toBe("opencode-go/future-test-model");
  });

  it("streaming: fallback happens before the stream, success is not interrupted", async () => {
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        controller.close();
      },
    });

    const used = [];
    mocks.handleChatCore.mockImplementation(async (chatArgs) => {
      used.push(chatArgs.credentials.connectionId);
      if (chatArgs.credentials.connectionId === "acc-a") {
        return {
          success: false,
          status: 429,
          error: "rate limit exceeded",
          response: new Response("{}", { status: 429 }),
        };
      }
      return {
        success: true,
        response: new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      };
    });

    const res = await invokeChat({ body: { stream: true } });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await res.text()).toContain("hello");
    expect(used).toEqual(["acc-a", "acc-b"]);
  });

  it("preserves the same session and model across an account switch", async () => {
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    const chat = scriptResponses([
      { ok: false, status: 429, error: "rate limit exceeded" },
      { ok: true },
    ]);

    const res = await invokeChat({ headers: { "x-session-id": "same-conversation" } });

    expect(res.status).toBe(200);
    expect(chat.args.map((a) => a.clientRawRequest.headers["x-session-id"]))
      .toEqual(["same-conversation", "same-conversation"]);
    expect(chat.args.map((a) => a.modelInfo.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-luna"]);
  });

  it("session cache skips a failed account on the next request even without a DB lock", async () => {
    const ctx = registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    const chat = scriptResponses([
      { ok: false, status: 429, error: "rate limit exceeded" },
      { ok: true },
      { ok: true },
    ]);
    const sessionHeaders = { "x-session-id": "session-persist-1" };

    await invokeChat({ headers: sessionHeaders });
    // Simulate the durable model lock being cleared between requests.
    ctx.locks.clear();
    await invokeChat({ headers: sessionHeaders });

    expect(chat.used).toEqual(["acc-a", "acc-b", "acc-b"]);
    // Third selection (second request) excluded acc-a via the session cache.
    expect(ctx.excludeSnapshots[2].has("acc-a")).toBe(true);
  });

  it("permanent bad-request does not rotate through remaining accounts", async () => {
    registerAccounts([{ id: "acc-a" }, { id: "acc-b" }, { id: "acc-c" }]);
    const chat = scriptResponses([
      { ok: false, status: 400, error: "Invalid request: messages must be an array" },
    ]);

    const res = await invokeChat();

    expect(res.status).toBe(400);
    expect(chat.used).toEqual(["acc-a"]);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("model-ineligible account is retired for that model and the next account serves it", async () => {
    const ctx = registerAccounts([{ id: "acc-a" }, { id: "acc-b" }]);
    const chat = scriptResponses([
      { ok: false, status: 400, error: "The model `gpt-5.6-luna` does not exist or you do not have access to it." },
      { ok: true },
      { ok: true },
    ]);
    const sessionHeaders = { "x-session-id": "session-capability-1" };

    const first = await invokeChat({ headers: sessionHeaders });
    expect(first.status).toBe(200);
    expect(chat.used).toEqual(["acc-a", "acc-b"]);

    // Durable lock cleared: the session cache alone must keep acc-a retired.
    ctx.locks.clear();
    const second = await invokeChat({ headers: sessionHeaders });

    expect(second.status).toBe(200);
    expect(chat.used).toEqual(["acc-a", "acc-b", "acc-b"]);
  });

  it("keeps normal providers on the same pool semantics", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4.5" });
    const ctx = registerAccounts([{ id: "anthropic-a" }, { id: "anthropic-b" }]);
    const chat = scriptResponses([
      { ok: false, status: 429, error: "rate limit exceeded" },
      { ok: true },
    ]);

    const res = await invokeChat({ model: "anthropic/claude-sonnet-4.5" });

    expect(res.status).toBe(200);
    expect(chat.used).toEqual(["anthropic-a", "anthropic-b"]);
    expect(ctx.excludeSnapshots[1].has("anthropic-a")).toBe(true);
  });

  it("existing combos keep using the combo path", async () => {
    mocks.getComboModels.mockResolvedValue(["openai/gpt-5.6-luna", "anthropic/claude-sonnet-4.5"]);
    mocks.handleComboChat.mockResolvedValue(
      new Response(JSON.stringify({ combo: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const res = await invokeChat({ model: "my-combo" });

    expect(res.status).toBe(200);
    expect((await res.json()).combo).toBe(true);
    expect(mocks.handleComboChat).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});
