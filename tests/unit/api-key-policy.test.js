import { describe, expect, it } from "vitest";
import {
  POLICY_PRESETS,
  defaultPolicy,
  evaluateBudgets,
  evaluateContent,
  evaluateFeatures,
  evaluateRateLimits,
  evaluateRequestCaps,
  evaluateSchedule,
  filterModelsByPolicy,
  ipMatchesRule,
  isModelAllowed,
  matchesRule,
  normalizePolicy,
  summarizePolicy,
  validatePolicy,
} from "../../src/lib/keys/policy.js";

describe("api key policy engine", () => {
  it("normalizes partial input over the defaults", () => {
    const policy = normalizePolicy({ enabled: true, budgets: { total: { tokens: 1000 } } });
    expect(policy.enabled).toBe(true);
    expect(policy.budgets.total.tokens).toBe(1000);
    expect(policy.budgets.total.period).toBe("month");
    // Invalid entries are dropped, not thrown.
    expect(policy.budgets.perProvider).toEqual({});
    expect(policy.features.tools).toBe(true);
  });

  it("reports validation errors for conflicting rules", () => {
    const { errors } = validatePolicy({
      access: { models: { mode: "allow", list: [] } },
      schedule: { allowedHours: [18, 9] },
      network: { ipAllowlist: ["not-an-ip"] },
    });
    expect(errors.length).toBe(3);
  });

  describe("access matching", () => {
    it("supports wildcards, allow and deny lists", () => {
      expect(matchesRule("openrouter", { mode: "allow", list: ["open*"] })).toBe(true);
      expect(matchesRule("openrouter", { mode: "deny", list: ["open*"] })).toBe(false);
      expect(matchesRule("mammouth", { mode: "allow", list: ["open*"] })).toBe(false);
    });

    it("matches models with or without provider prefix", () => {
      const policy = normalizePolicy({ access: { models: { mode: "allow", list: ["gpt-5.4-mini", "claude-*"] } } });
      expect(isModelAllowed(policy, "openai", "gpt-5.4-mini")).toBe(true);
      expect(isModelAllowed(policy, "anthropic", "claude-haiku-4-5")).toBe(true);
      expect(isModelAllowed(policy, "openai", "gpt-6-astra")).toBe(false);
    });

    it("applies per-provider model overrides", () => {
      const policy = normalizePolicy({
        access: { models: { mode: "all", list: [], perProvider: { mammouth: { mode: "allow", list: ["gpt-5.4"] } } } },
      });
      expect(isModelAllowed(policy, "mammouth", "gpt-5.4")).toBe(true);
      expect(isModelAllowed(policy, "mammouth", "claude-opus-5")).toBe(false);
      // Other providers stay unrestricted.
      expect(isModelAllowed(policy, "openrouter", "claude-opus-5")).toBe(true);
    });

    it("filters combo model lists", () => {
      const policy = POLICY_PRESETS.find((preset) => preset.id === "cheap").build();
      const filtered = filterModelsByPolicy(policy, [
        "openai/gpt-5.4-mini",
        "openai/gpt-6-astra",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-5",
      ]);
      expect(filtered).toEqual(["openai/gpt-5.4-mini", "anthropic/claude-haiku-4-5"]);
    });
  });

  describe("budgets", () => {
    const policy = normalizePolicy({
      enabled: true,
      budgets: {
        total: { tokens: 1000, costUsd: 5, period: "day" },
        perProvider: { openai: { percentOfQuota: 20, period: "month" } },
      },
    });
    const usage = {
      periods: {
        day: {
          total: { requests: 3, tokens: 1500, costUsd: 1 },
          byProvider: { openai: { requests: 3, tokens: 1500, costUsd: 1 } },
          byModel: {},
          byConnection: {},
        },
        month: {
          total: { requests: 3, tokens: 1500, costUsd: 1 },
          byProvider: { openai: { requests: 3, tokens: 1500, costUsd: 1 } },
          byModel: {},
          byConnection: {},
        },
      },
      liveQuota: { openai: { usedPct: 50 } },
      providerTotals: { openai: { tokens: 15000 } },
    };

    it("flags exceeded token budgets", () => {
      const violations = evaluateBudgets(policy, usage);
      expect(violations.some((violation) => violation.code === "budget_tokens")).toBe(true);
    });

    it("attributes a share of the live provider quota", () => {
      // key used 1500 of 15000 provider tokens = 10% share of a 50% used quota = 5%.
      const violations = evaluateBudgets(policy, usage);
      expect(violations.some((violation) => violation.code === "budget_provider_quota")).toBe(false);

      const overUsage = {
        ...usage,
        liveQuota: { openai: { usedPct: 90 } },
        providerTotals: { openai: { tokens: 5000 } },
      };
      const over = evaluateBudgets(policy, overUsage);
      expect(over.some((violation) => violation.code === "budget_provider_quota")).toBe(true);
    });

    it("does not flag when usage is under the limits", () => {
      const under = {
        periods: {
          day: { total: { requests: 1, tokens: 10, costUsd: 0.1 }, byProvider: {}, byModel: {}, byConnection: {} },
          month: { total: { requests: 1, tokens: 10, costUsd: 0.1 }, byProvider: {}, byModel: {}, byConnection: {} },
        },
        liveQuota: {},
        providerTotals: {},
      };
      expect(evaluateBudgets(policy, under)).toHaveLength(0);
    });
  });

  it("enforces rate limits", () => {
    const policy = normalizePolicy({ rateLimits: { requestsPerMinute: 2, requestsPerHour: null, maxConcurrent: 1 } });
    const violations = evaluateRateLimits(policy, { rpm: 2, rph: 10, concurrent: 1 });
    expect(violations.map((violation) => violation.code)).toEqual(["rate_rpm", "rate_concurrent"]);
  });

  it("checks schedule days/hours and expiry", () => {
    const mondayTen = new Date("2026-09-14T10:00:00"); // Monday
    const policy = normalizePolicy({ schedule: { allowedDays: [1, 2, 3, 4, 5], allowedHours: [9, 18] } });
    expect(evaluateSchedule(policy, mondayTen)).toHaveLength(0);

    const sunday = new Date("2026-09-13T10:00:00");
    expect(evaluateSchedule(policy, sunday).some((violation) => violation.code === "schedule_day")).toBe(true);

    const late = new Date("2026-09-14T20:00:00");
    expect(evaluateSchedule(policy, late).some((violation) => violation.code === "schedule_hours")).toBe(true);

    const expired = normalizePolicy({ schedule: { expiresAt: "2020-01-01T00:00:00Z" } });
    expect(evaluateSchedule(expired, mondayTen).some((violation) => violation.code === "schedule_expired")).toBe(true);
  });

  it("matches IPv4 CIDR ranges", () => {
    expect(ipMatchesRule("10.0.0.5", "10.0.0.0/24")).toBe(true);
    expect(ipMatchesRule("10.0.1.5", "10.0.0.0/24")).toBe(false);
    expect(ipMatchesRule("203.0.113.7", "203.0.113.7")).toBe(true);
  });

  it("evaluates content rules", () => {
    const policy = normalizePolicy({ content: { blockedKeywords: ["secret"], requiredKeywords: ["9router"], requireSystemPrompt: true } });
    const violation = evaluateContent(policy, { messages: [{ role: "user", content: "my secret plan" }] });
    expect(violation.map((entry) => entry.code).sort()).toEqual(["content_blocked", "content_required", "content_system_prompt"]);
  });

  it("evaluates feature flags and clamps output tokens", () => {
    const policy = normalizePolicy({ features: { tools: false, streaming: false }, requestCaps: { maxOutputTokens: 100 } });
    const violations = evaluateFeatures(policy, { body: { stream: true, tools: [{ type: "function" }] }, endpoint: "/v1/chat/completions" });
    expect(violations.map((entry) => entry.code).sort()).toEqual(["feature_streaming", "feature_tools"]);
    const caps = evaluateRequestCaps(policy, { body: { messages: [{ role: "user", content: "hi" }], max_tokens: 900 } });
    expect(caps.clampedMaxTokens).toBe(100);
  });

  it("summarizes a policy in plain English", () => {
    const policy = POLICY_PRESETS.find((preset) => preset.id === "team").build();
    const lines = summarizePolicy(policy);
    expect(lines.join("\n")).toContain("2,000,000 tokens");
    expect(lines.join("\n")).toContain("Rate limit");
  });

  it("keeps the default policy unrestricted", () => {
    expect(defaultPolicy().enabled).toBe(false);
    expect(summarizePolicy(defaultPolicy())).toEqual(["Access is unrestricted (policy disabled)."]);
  });
});
