import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POOL_ACTIONS,
  clearAccountPoolCache,
  classifyPoolError,
  getAccountPoolSize,
  getSessionExcludedAccountIds,
  getSessionRetryAt,
  isModelCapabilityError,
  isRequestScopedError,
  recordAccountFailure,
  recordAccountSuccess,
  resolvePoolSessionKey,
} from "../../open-sse/services/accountPool.js";

const SESSION_HEADERS = { "x-session-id": "conversation-1" };

describe("classifyPoolError", () => {
  it("treats 429 / quota / overload as fallback", () => {
    expect(classifyPoolError(429, "rate limit exceeded").action).toBe(POOL_ACTIONS.FALLBACK);
    expect(classifyPoolError(429, "You have exceeded your quota").action).toBe(POOL_ACTIONS.FALLBACK);
    expect(classifyPoolError(503, "overloaded").action).toBe(POOL_ACTIONS.FALLBACK);
    expect(classifyPoolError(500, "internal error").action).toBe(POOL_ACTIONS.FALLBACK);
    expect(classifyPoolError(502, "bad gateway").action).toBe(POOL_ACTIONS.FALLBACK);
  });

  it("keeps explicit auth rules on the fallback path", () => {
    expect(classifyPoolError(401, "invalid api key").action).toBe(POOL_ACTIONS.FALLBACK);
    expect(classifyPoolError(403, "forbidden").action).toBe(POOL_ACTIONS.FALLBACK);
    expect(classifyPoolError(402, "payment required").action).toBe(POOL_ACTIONS.FALLBACK);
  });

  it("keeps the 'request not allowed' text rule on the fallback path", () => {
    expect(classifyPoolError(400, "Request not allowed in this region").action).toBe(POOL_ACTIONS.FALLBACK);
  });

  it("detects model-capability errors in common upstream phrasings", () => {
    const cases = [
      [400, "The model `gpt-5.6-luna` does not exist or you do not have access to it."],
      [404, "model_not_found"],
      [404, '{"type":"error","error":{"type":"not_found_error","message":"model: x"}}'],
      [404, "model: claude-3-5-sonnet-20241022"],
      [400, "The requested model is not supported"],
      [400, "This model is not available on your plan"],
      [400, "unsupported_api_for_model"],
      [400, "Unsupported model: foo-bar"],
    ];
    for (const [status, text] of cases) {
      expect(isModelCapabilityError(status, text), text).toBe(true);
      expect(classifyPoolError(status, text).action, text).toBe(POOL_ACTIONS.CAPABILITY);
    }
  });

  it("detects request-scoped errors and stops rotation", () => {
    const cases = [
      [400, "Invalid request: messages must be an array"],
      [400, "malformed tool call"],
      [400, '{"error":{"message":"Unexpected token < in JSON"}}'],
      [400, "invalid parameter: temperature"],
      [400, "This model's maximum context length is 128000 tokens"],
      [400, "missing required field: messages"],
      [422, "arguments must be valid JSON"],
    ];
    for (const [status, text] of cases) {
      expect(isRequestScopedError(status, text), text).toBe(true);
      expect(classifyPoolError(status, text).action, text).toBe(POOL_ACTIONS.NON_FALLBACK);
    }
  });

  it("does not classify unknown 400 text as request-scoped (keeps legacy rotation)", () => {
    expect(isRequestScopedError(400, "unknown field foo")).toBe(false);
    expect(classifyPoolError(400, "unknown field foo").action).toBe(POOL_ACTIONS.FALLBACK);
  });

  it("never treats transient 4xx as request-scoped", () => {
    for (const status of [408, 409, 425, 429]) {
      expect(isRequestScopedError(status, "invalid request")).toBe(false);
    }
  });
});

describe("resolvePoolSessionKey", () => {
  it("is stable across accounts and providers are isolated", () => {
    const a = resolvePoolSessionKey({ provider: "opencode-go", headers: SESSION_HEADERS, body: {} });
    const b = resolvePoolSessionKey({ provider: "opencode-go", headers: SESSION_HEADERS, body: {} });
    const c = resolvePoolSessionKey({ provider: "anthropic", headers: SESSION_HEADERS, body: {} });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("returns null without a provider", () => {
    expect(resolvePoolSessionKey({ headers: SESSION_HEADERS })).toBeNull();
  });
});

describe("session failure cache", () => {
  const sessionKey = "opencode-go\\0conversation-1";

  beforeEach(() => clearAccountPoolCache());
  afterEach(() => clearAccountPoolCache());

  it("excludes a failed account for the same model only", () => {
    recordAccountFailure(sessionKey, "acc-a", { model: "gpt-5.6-luna", status: 429, cooldownMs: 30_000 });
    expect([...getSessionExcludedAccountIds(sessionKey, "gpt-5.6-luna")]).toEqual(["acc-a"]);
    expect([...getSessionExcludedAccountIds(sessionKey, "mimo-v2.5")]).toEqual([]);
  });

  it("account-wide failures apply to every model", () => {
    recordAccountFailure(sessionKey, "acc-a", { model: null, status: 401, cooldownMs: 30_000 });
    expect([...getSessionExcludedAccountIds(sessionKey, "gpt-5.6-luna")]).toEqual(["acc-a"]);
    expect([...getSessionExcludedAccountIds(sessionKey, "future-model")]).toEqual(["acc-a"]);
  });

  it("expires entries after their cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    try {
      recordAccountFailure(sessionKey, "acc-a", { model: "m", status: 429, cooldownMs: 5_000 });
      expect(getSessionExcludedAccountIds(sessionKey, "m").size).toBe(1);
      vi.advanceTimersByTime(6_000);
      expect(getSessionExcludedAccountIds(sessionKey, "m").size).toBe(0);
      expect(getAccountPoolSize()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not offer a retry-after for capability blocks", () => {
    recordAccountFailure(sessionKey, "acc-a", { model: "m", status: 400, cooldownMs: 1_800_000, action: POOL_ACTIONS.CAPABILITY });
    expect(getSessionRetryAt(sessionKey, "m")).toBeNull();
  });

  it("exposes the earliest cooldown for fallback failures", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    try {
      recordAccountFailure(sessionKey, "acc-a", { model: "m", status: 429, cooldownMs: 10_000 });
      recordAccountFailure(sessionKey, "acc-b", { model: "m", status: 429, cooldownMs: 5_000 });
      expect(getSessionRetryAt(sessionKey, "m")).toBe(new Date(Date.now() + 5_000).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears only the succeeded model on success", () => {
    recordAccountFailure(sessionKey, "acc-a", { model: "model-x", status: 400, cooldownMs: 1_800_000, action: POOL_ACTIONS.CAPABILITY });
    recordAccountFailure(sessionKey, "acc-a", { model: "model-y", status: 429, cooldownMs: 30_000 });
    recordAccountSuccess(sessionKey, "acc-a", "model-y");
    expect([...getSessionExcludedAccountIds(sessionKey, "model-x")]).toEqual(["acc-a"]);
    expect([...getSessionExcludedAccountIds(sessionKey, "model-y")]).toEqual([]);
  });

  it("keeps an account-wide block until an explicit success clears it", () => {
    recordAccountFailure(sessionKey, "acc-a", { model: null, status: 401, cooldownMs: 30_000 });
    recordAccountSuccess(sessionKey, "acc-a", "model-y");
    expect([...getSessionExcludedAccountIds(sessionKey, "model-y")]).toEqual([]);
  });
});
