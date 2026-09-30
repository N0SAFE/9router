import { beforeEach, describe, expect, it } from "vitest";

async function loadRegistry() {
  const mod = await import("../../src/lib/usage/liveRouting.js");
  return mod;
}

describe("liveRouting error text", () => {
  let live;

  beforeEach(async () => {
    // The registry is a module-level singleton; reset it between cases.
    if (globalThis._liveRouting) {
      globalThis._liveRouting.map.clear();
    }
    live = await loadRegistry();
  });

  it("flattens an object error into plain text on the error event", () => {
    // startLiveRequest returns the entry, not the id — pass the id explicitly.
    live.startLiveRequest({ id: "req-1", provider: "opencode-go", model: "deepseek-v4.1-flash" });
    live.pushRoutingEvent("req-1", { type: "error", status: 400, error: { error: { message: "context length exceeded" } } });

    const entry = live.getLiveRequest("req-1");
    expect(entry.error).toBe("context length exceeded");
    expect(entry.error).not.toContain("[object Object]");
  });

  it("flattens an object error on an attempt event", () => {
    live.startLiveRequest({ id: "req-2", provider: "opencode-go", model: "m" });
    live.pushRoutingEvent("req-2", {
      type: "attempt",
      status: 400,
      error: { model: "deepseek-v4.1-flash" },
      action: "fallback",
    });

    const entry = live.getLiveRequest("req-2");
    expect(entry.attempts[0].error).toBe('{"model":"deepseek-v4.1-flash"}');
    expect(entry.attempts[0].error).not.toContain("[object Object]");
  });

  it("keeps the emitted SSE event free of object errors", () => {
    live.startLiveRequest({ id: "req-3", provider: "p", model: "m" });
    const normalized = live.pushRoutingEvent("req-3", {
      type: "error",
      status: 500,
      error: { message: "upstream died" },
      message: { message: "upstream died" },
    });

    expect(normalized.error).toBe("upstream died");
    expect(normalized.message).toBe("upstream died");
    expect(JSON.stringify(normalized)).not.toContain("[object Object]");
  });

  it("survives circular error objects without throwing", () => {
    live.startLiveRequest({ id: "req-4", provider: "p", model: "m" });
    const circular = { message: "loop detected" };
    circular.error = circular;

    expect(() => live.pushRoutingEvent("req-4", { type: "error", status: 400, error: circular })).not.toThrow();
    expect(live.getLiveRequest("req-4").error).toBe("loop detected");
  });

  it("flattens an object error passed to finishLiveRequest", () => {
    live.startLiveRequest({ id: "req-5", provider: "p", model: "m" });
    live.finishLiveRequest("req-5", { status: "error", error: { detail: "rate limited" } });
    expect(live.getLiveRequest("req-5").error).toBe("rate limited");
  });

  it("still marks a context problem from an object error", () => {
    live.startLiveRequest({ id: "req-6", provider: "p", model: "m" });
    live.pushRoutingEvent("req-6", { type: "error", status: 400, error: { message: "maximum context length is 1000000" } });
    expect(live.getLiveRequest("req-6").contextProblem).toBe(true);
  });
});