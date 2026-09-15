import { describe, expect, it } from "vitest";
import {
  analyzeRequest,
  analyzeRequestDetails,
  getCachedTokens,
  getInputTokens,
  INSIGHT_THRESHOLDS,
} from "../../src/lib/usage/insights.js";

const row = (overrides = {}) => ({
  id: overrides.id || "r1",
  timestamp: "2026-09-14T10:00:00.000Z",
  provider: "opencode-go",
  model: "mimo-v2.5",
  status: "success",
  latency: { ttft: 100, total: 2000 },
  tokens: {},
  ...overrides,
});

describe("token getters", () => {
  it("keeps cache-inclusive input and falls back to cache when legacy rows under-report", () => {
    expect(getInputTokens({ prompt_tokens: 1000, cached_tokens: 400 })).toBe(1000);
    expect(getInputTokens({ prompt_tokens: 100, cache_read_input_tokens: 500 })).toBe(500);
    expect(getCachedTokens({ cache_read_input_tokens: 300 })).toBe(300);
  });
});

describe("analyzeRequest flags", () => {
  it("flags oversized context", () => {
    const a = analyzeRequest(row({ tokens: { prompt_tokens: 150_000, completion_tokens: 100 } }));
    expect(a.flags.map((f) => f.id)).toContain("oversized_context");
    expect(a.wastedTokens).toBeGreaterThan(0);
  });

  it("flags a large prompt with no cache reuse", () => {
    const a = analyzeRequest(row({ tokens: { prompt_tokens: 50_000, completion_tokens: 50 } }));
    expect(a.flags.map((f) => f.id)).toContain("no_cache_reuse");
    expect(a.wastedTokens).toBeGreaterThan(0);
  });

  it("flags a low cache ratio instead of a total miss", () => {
    const a = analyzeRequest(row({ tokens: { prompt_tokens: 50_000, cached_tokens: 1_000, completion_tokens: 50 } }));
    const ids = a.flags.map((f) => f.id);
    expect(ids).toContain("low_cache_ratio");
    expect(ids).not.toContain("no_cache_reuse");
  });

  it("flags heavy reasoning output", () => {
    const a = analyzeRequest(row({ tokens: { prompt_tokens: 1_000, completion_tokens: 4_000, reasoning_tokens: 3_000 } }));
    expect(a.flags.map((f) => f.id)).toContain("reasoning_heavy");
  });

  it("flags very large generations", () => {
    const a = analyzeRequest(row({ tokens: { prompt_tokens: 500, completion_tokens: 30_000 } }));
    expect(a.flags.map((f) => f.id)).toContain("xlarge_output");
  });

  it("flags big tool catalogues", () => {
    const tools = Array.from({ length: 30 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: { type: "object" } } }));
    const a = analyzeRequest(row({ request: { tools } }));
    expect(a.flags.map((f) => f.id)).toContain("large_tool_schema");
    expect(a.toolCount).toBe(30);
  });

  it("flags long histories", () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" }));
    const a = analyzeRequest(row({ request: { messages }, tokens: { prompt_tokens: 30_000, cached_tokens: 25_000 } }));
    expect(a.flags.map((f) => f.id)).toContain("long_history");
  });

  it("flags failed requests as fully wasted", () => {
    const a = analyzeRequest(row({ status: "429", tokens: { prompt_tokens: 2_000, completion_tokens: 0 } }));
    const ids = a.flags.map((f) => f.id);
    expect(ids).toContain("retry_waste");
    expect(a.wastedTokens).toBe(2_000);
  });

  it("flags expensive requests using the injected estimator", () => {
    const a = analyzeRequest(row({ tokens: { prompt_tokens: 1_000, completion_tokens: 500 } }), { costEstimator: () => 0.2 });
    expect(a.flags.map((f) => f.id)).toContain("expensive_model");
    expect(a.cost).toBeCloseTo(0.2);
  });

  it("caps avoidable tokens at what the request actually spent", () => {
    const a = analyzeRequest(row({
      status: "500",
      tokens: { prompt_tokens: 150_000, completion_tokens: 5_000, reasoning_tokens: 1_000 },
    }));
    expect(a.wastedTokens).toBeLessThanOrEqual(a.total + a.reasoning);
  });

  it("returns no flags for a lean, cached request", () => {
    const a = analyzeRequest(row({ tokens: { prompt_tokens: 5_000, cached_tokens: 4_500, completion_tokens: 300 } }));
    expect(a.flags).toHaveLength(0);
    expect(a.wastedTokens).toBe(0);
    expect(a.wasteScore).toBe(0);
  });

  it("treats a truncated request body as an oversized-context signal", () => {
    const a = analyzeRequest(row({
      request: { _truncated: true, _originalSize: 40_000 },
      tokens: { prompt_tokens: 25_000, cached_tokens: 20_000, completion_tokens: 10 },
    }));
    expect(a.flags.map((f) => f.id)).toContain("oversized_context");
  });
});

describe("analyzeRequestDetails", () => {
  const rows = [
    row({ id: "a", tokens: { prompt_tokens: 150_000, completion_tokens: 200 } }),
    row({ id: "b", tokens: { prompt_tokens: 30_000, completion_tokens: 4_000, reasoning_tokens: 3_000 } }),
    row({ id: "c", status: "429", tokens: { prompt_tokens: 1_000, completion_tokens: 0 } }),
    row({ id: "d", tokens: { prompt_tokens: 5_000, cached_tokens: 4_500, completion_tokens: 200 } }),
  ];

  it("aggregates the overview", () => {
    const { overview } = analyzeRequestDetails(rows, { costEstimator: (r) => (r.id === "a" ? 0.3 : 0.001) });
    expect(overview.requests).toBe(4);
    expect(overview.successes).toBe(3);
    expect(overview.failures).toBe(1);
    expect(overview.inputTokens).toBe(150_000 + 30_000 + 1_000 + 5_000);
    expect(overview.cachedTokens).toBe(4_500);
    expect(overview.outputTokens).toBe(200 + 4_000 + 0 + 200);
    expect(overview.totalCost).toBeCloseTo(0.303, 5);
    expect(overview.potentialSavingsTokens).toBeGreaterThan(0);
    expect(overview.potentialSavingsUsd).toBeGreaterThan(0);
    expect(overview.cacheHitRate).toBeGreaterThan(0);
    expect(overview.avgLatencyMs).toBe(2000);
  });

  it("aggregates patterns with occurrences, ranked by severity then impact", () => {
    const { patterns } = analyzeRequestDetails(rows);
    const byId = Object.fromEntries(patterns.map((p) => [p.id, p]));
    expect(byId.oversized_context.occurrences).toBe(1);
    expect(byId.no_cache_reuse.occurrences).toBe(2);
    expect(byId.reasoning_heavy.occurrences).toBe(1);
    expect(byId.retry_waste.occurrences).toBe(1);
    expect(byId.oversized_context.severity).toBe("high");
    expect(byId.oversized_context.tip.length).toBeGreaterThan(10);
    // High severity sorts before medium/low.
    const severities = patterns.map((p) => p.severity);
    expect(severities.indexOf("high")).toBeLessThan(severities.lastIndexOf("low") === -1 ? severities.length : severities.lastIndexOf("low"));
  });

  it("lists offenders sorted by avoidable tokens and bounded", () => {
    const { offenders } = analyzeRequestDetails(rows);
    expect(offenders.length).toBeGreaterThan(0);
    for (let i = 1; i < offenders.length; i++) {
      expect(offenders[i - 1].wastedTokens).toBeGreaterThanOrEqual(offenders[i].wastedTokens);
    }
    expect(offenders[0].id).toBe("a");
    expect(offenders[0].tokens).toBeDefined();
  });

  it("handles empty input", () => {
    const { overview, patterns, offenders } = analyzeRequestDetails([]);
    expect(overview.requests).toBe(0);
    expect(overview.potentialSavingsTokens).toBe(0);
    expect(patterns).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("exposes thresholds for the UI", () => {
    expect(INSIGHT_THRESHOLDS.oversizedContextTokens).toBe(100_000);
  });
});
