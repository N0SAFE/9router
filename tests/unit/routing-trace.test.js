import { describe, expect, it } from "vitest";
import {
  createRoutingTrace,
  ensureCombo,
  recordAccountAttempt,
  recordAccountSelected,
  recordComboModel,
  recordModelSelection,
  recordPool,
  routingSummary,
} from "../../open-sse/services/routingTrace.js";

describe("createRoutingTrace", () => {
  it("starts empty for a single model", () => {
    const trace = createRoutingTrace({ requestedModel: "opencode-go/mimo-v2.5" });
    expect(trace.requestedModel).toBe("opencode-go/mimo-v2.5");
    expect(trace.combo).toBeNull();
    expect(trace.attempts).toEqual([]);
  });

  it("bootstraps combo metadata", () => {
    const trace = createRoutingTrace({
      requestedModel: "my-combo",
      comboName: "my-combo",
      comboStrategy: "round-robin",
      adapterAdded: ["oc/mimo-v2.5-free"],
    });
    expect(trace.combo).toMatchObject({ name: "my-combo", strategy: "round-robin", adapterModels: ["oc/mimo-v2.5-free"] });
  });
});

describe("combo recording", () => {
  it("updates a pending model entry to its final status", () => {
    const trace = createRoutingTrace({ requestedModel: "c", comboName: "c" });
    recordComboModel(trace, "a/model", { status: "pending" });
    recordComboModel(trace, "b/model", { status: "pending" });
    recordComboModel(trace, "a/model", { status: "failed:429", error: "rate limit" });
    recordComboModel(trace, "b/model", { status: "success" });
    expect(trace.combo.models).toEqual([
      { model: "a/model", status: "failed:429", error: "rate limit" },
      { model: "b/model", status: "success", error: null },
    ]);
  });

  it("ensureCombo is idempotent and keeps recorded models", () => {
    const trace = createRoutingTrace({ requestedModel: "c", comboName: "c" });
    recordComboModel(trace, "a", { status: "success" });
    ensureCombo(trace, { name: "c", strategy: "fallback" });
    expect(trace.combo.models).toHaveLength(1);
  });
});

describe("model + pool + account", () => {
  it("records the resolved provider/model and selected account", () => {
    const trace = createRoutingTrace({ requestedModel: "m" });
    recordModelSelection(trace, { provider: "opencode-go", model: "mimo-v2.5" });
    recordPool(trace, { provider: "opencode-go", total: 4, available: 2 });
    recordAccountSelected(trace, { connectionId: "abc123", connectionName: "sub 1", reason: "fill-first" });
    expect(trace).toMatchObject({ provider: "opencode-go", model: "mimo-v2.5" });
    expect(trace.pool).toMatchObject({ total: 4, available: 2 });
    expect(trace.selected).toMatchObject({ connectionId: "abc123", name: "sub 1", reason: "fill-first" });
  });

  it("links each failed attempt to the next account", () => {
    const trace = createRoutingTrace({ requestedModel: "m" });
    recordAccountAttempt(trace, { connectionId: "a", name: "A", status: 429, action: "fallback", cooldownMs: 2000 });
    recordAccountAttempt(trace, { connectionId: "b", name: "B", status: 400, action: "capability", cooldownMs: 1800000 });
    recordAccountAttempt(trace, { connectionId: "c", name: "C", status: 502, action: "fallback", cooldownMs: 30000 });
    expect(trace.attempts.map((a) => a.redirectTo)).toEqual(["b", "c", undefined]);
    expect(trace.attempts[1].cooldownMs).toBe(1800000);
  });

  it("caps attempts and clips long errors", () => {
    const trace = createRoutingTrace({ requestedModel: "m" });
    for (let i = 0; i < 60; i++) {
      recordAccountAttempt(trace, { connectionId: `a${i}`, status: 429, error: "x".repeat(1000), action: "fallback" });
    }
    expect(trace.attempts.length).toBeLessThanOrEqual(30);
    expect(trace.attempts[0].error.length).toBeLessThanOrEqual(221);
  });
});

describe("routingSummary", () => {
  it("summarizes pool redirects and the used account", () => {
    const trace = createRoutingTrace({ requestedModel: "m" });
    recordModelSelection(trace, { provider: "opencode-go", model: "mimo-v2.5" });
    recordAccountSelected(trace, { connectionId: "b", connectionName: "sub 2", reason: "fill-first" });
    recordAccountAttempt(trace, { connectionId: "a", name: "A", status: 429, action: "fallback" });
    const summary = routingSummary(trace);
    expect(summary).toContain("pool:opencode-go");
    expect(summary).toContain("A:429");
    expect(summary).toContain("used:sub 2");
  });

  it("summarizes combos with the ok/total model count", () => {
    const trace = createRoutingTrace({ requestedModel: "c", comboName: "c" });
    recordComboModel(trace, "a", { status: "failed:429" });
    recordComboModel(trace, "b", { status: "success" });
    expect(routingSummary(trace)).toContain("combo:c(1/2)");
  });

  it("returns an empty string for a null trace", () => {
    expect(routingSummary(null)).toBe("");
  });
});
