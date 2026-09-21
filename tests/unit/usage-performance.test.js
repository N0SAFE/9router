import { describe, expect, it } from "vitest";
import {
  aggregatePerformance,
  buildPerformanceSeries,
  dimensionKey,
  percentile,
  seriesBuckets,
} from "../../src/lib/usage/performance.js";

function row(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    connectionId: "conn-1",
    apiKey: "sk-test-key",
    endpoint: "/v1/chat/completions",
    status: "ok",
    promptTokens: 1000,
    completionTokens: 500,
    cachedTokens: 400,
    reasoningTokens: 100,
    costUsd: 0.01,
    ttft: 1000,
    total: 3000,
    ...overrides,
  };
}

describe("usage performance aggregation", () => {
  it("computes throughput and input speed from latency", () => {
    const { items } = aggregatePerformance([row()], { dimension: "model" });
    expect(items).toHaveLength(1);
    const metrics = items[0];
    // 500 completion tokens over (3000 - 1000) ms = 250 tok/s.
    expect(metrics.outputSpeedAvg).toBeCloseTo(250, 5);
    // 1000 prompt tokens over 1000 ms TTFT = 1000 tok/s.
    expect(metrics.inputSpeedAvg).toBeCloseTo(1000, 5);
    expect(metrics.ttftAvg).toBe(1000);
    expect(metrics.totalP95).toBe(3000);
    expect(metrics.cacheHitRate).toBeCloseTo(0.4, 5);
    expect(metrics.costPer1kTokens).toBeCloseTo((0.01 / 1500) * 1000, 6);
    expect(metrics.successRate).toBe(1);
  });

  it("falls back to full latency for output speed when TTFT is unknown", () => {
    const { items } = aggregatePerformance([row({ ttft: null })], { dimension: "model" });
    // 500 tokens over 3000 ms = 166.67 tok/s.
    expect(items[0].outputSpeedAvg).toBeCloseTo(500 / 3, 2);
    expect(items[0].inputSpeedAvg).toBeNull();
    expect(items[0].ttftSamples).toBe(0);
  });

  it("groups by provider, connection and endpoint", () => {
    const rows = [
      row({ connectionId: "a", provider: "p1" }),
      row({ connectionId: "b", provider: "p2" }),
      row({ connectionId: "b", provider: "p2" }),
    ];
    expect(aggregatePerformance(rows, { dimension: "provider" }).items.map((item) => [item.key, item.requests])).toEqual([
      ["p2", 2],
      ["p1", 1],
    ]);
    expect(aggregatePerformance(rows, { dimension: "connection" }).items.map((item) => item.requests)).toEqual([2, 1]);
    expect(dimensionKey(rows[0], "apiKey")).toBe("sk-test-key");
    expect(dimensionKey(rows[0], "endpoint")).toBe("/v1/chat/completions");
  });

  it("reports latency coverage so partial data is visible", () => {
    const rows = [row(), row({ total: null, ttft: null }), row({ ttft: null })];
    const { latencyCoverage } = aggregatePerformance(rows, { dimension: "model" });
    expect(latencyCoverage).toEqual({ withLatency: 2, withTtft: 1, total: 3 });
  });

  it("percentile picks sensible values", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([], 50)).toBeNull();
  });

  it("builds a time series, optionally filtered to one key", () => {
    const now = Date.now();
    const rows = [
      row({ timestamp: new Date(now - 60_000).toISOString(), model: "a" }),
      row({ timestamp: new Date(now - 120_000).toISOString(), model: "b" }),
    ];
    const series = buildPerformanceSeries(rows, { period: "today", dimension: "model" });
    const bucketTotal = series.reduce((sum, bucket) => sum + bucket.requests, 0);
    expect(bucketTotal).toBe(2);
    const onlyA = buildPerformanceSeries(rows, { period: "today", dimension: "model", key: "opencode-go/a" });
    expect(onlyA.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(1);
  });

  it("series buckets match the period granularity", () => {
    expect(seriesBuckets("1h")).toHaveLength(12);
    expect(seriesBuckets("24h")).toHaveLength(24);
    expect(seriesBuckets("7d")).toHaveLength(7);
    expect(seriesBuckets("30d")).toHaveLength(30);
  });
});
