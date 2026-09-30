import { describe, it, expect } from "vitest";
import {
  toPlainErrorMessage,
  buildErrorBody,
  errorResponse,
  createErrorResult,
  unavailableResponse,
  parseUpstreamError,
  formatProviderError,
} from "../../open-sse/utils/error.js";

describe("toPlainErrorMessage", () => {
  it("passes strings through and falls back on blanks", () => {
    expect(toPlainErrorMessage("boom")).toBe("boom");
    expect(toPlainErrorMessage("   ")).toBe("");
    expect(toPlainErrorMessage("", "fb")).toBe("fb");
    expect(toPlainErrorMessage(null, "fb")).toBe("fb");
    expect(toPlainErrorMessage(undefined, "fb")).toBe("fb");
  });

  it("unwraps the common upstream error envelopes", () => {
    expect(toPlainErrorMessage({ message: "context too long" })).toBe("context too long");
    expect(toPlainErrorMessage({ error: { message: "rate limited" } })).toBe("rate limited");
    expect(toPlainErrorMessage({ error: "quota exceeded" })).toBe("quota exceeded");
    expect(toPlainErrorMessage({ detail: "bad param" })).toBe("bad param");
    expect(toPlainErrorMessage({ reason: "unsupported" })).toBe("unsupported");
  });

  it("serialises message-less objects instead of leaking [object Object]", () => {
    const out = toPlainErrorMessage({ model: "deepseek-v4.1-flash" });
    expect(out).not.toContain("[object Object]");
    expect(out).toBe('{"model":"deepseek-v4.1-flash"}');
  });

  it("stringifies primitives and Errors", () => {
    expect(toPlainErrorMessage(42)).toBe("42");
    expect(toPlainErrorMessage(false)).toBe("false");
    expect(toPlainErrorMessage(new Error("socket hang up"))).toBe("socket hang up");
  });

  it("takes the first usable entry of an array", () => {
    expect(toPlainErrorMessage([{ code: "x" }, { message: "second" }])).toBe('{"code":"x"}');
    expect(toPlainErrorMessage([{ message: "first" }])).toBe("first");
  });

  it("survives self-referencing and circular structures", () => {
    const self = { message: "loop" };
    self.error = self;
    expect(toPlainErrorMessage(self)).toBe("loop");

    const a = { detail: "" };
    const b = { error: a };
    a.reason = b;
    expect(() => toPlainErrorMessage(a)).not.toThrow();
  });

  it("caps very large serialised payloads", () => {
    const out = toPlainErrorMessage({ blob: "x".repeat(9000) });
    expect(out.length).toBeLessThanOrEqual(4001);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildErrorBody", () => {
  it("always emits a string message field", () => {
    for (const message of [
      "plain",
      { message: "nested" },
      { error: { message: "deep" } },
      { model: "m" },
      7,
    ]) {
      const body = buildErrorBody(400, message);
      expect(typeof body.error.message).toBe("string");
      expect(body.error.message).not.toContain("[object Object]");
    }
  });

  it("falls back to the status default when the message is empty", () => {
    expect(buildErrorBody(400, "").error.message).toBe("Bad request");
    expect(buildErrorBody(400, {}).error.message).toBe("Bad request");
  });
});

describe("errorResponse", () => {
  it("serialises an object message as plain text", async () => {
    const res = errorResponse(400, { error: { message: "upstream said no" } });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toBe("upstream said no");
  });
});

describe("createErrorResult", () => {
  it("keeps .error a string and mirrors it into the response body", async () => {
    const result = createErrorResult(400, { error: { message: "nope" } });
    expect(result.success).toBe(false);
    expect(result.error).toBe("nope");
    expect((await result.response.json()).error.message).toBe("nope");
  });
});

describe("unavailableResponse", () => {
  it("stringifies an object message", async () => {
    const res = unavailableResponse(503, { error: { message: "all cooling down" } }, new Date(Date.now() + 30_000), "reset after 30s");
    const json = await res.json();
    expect(json.error.message).toContain("all cooling down");
    expect(json.error.message).not.toContain("[object Object]");
  });
});

describe("parseUpstreamError", () => {
  it("prefers the upstream message over the raw body", async () => {
    const res = new Response(JSON.stringify({ error: { message: "context length exceeded" } }), { status: 400 });
    const out = await parseUpstreamError(res);
    expect(out.statusCode).toBe(400);
    expect(out.message).toBe("context length exceeded");
  });

  it("falls back to the raw body when the JSON has no message field", async () => {
    const raw = '{"model":"deepseek-v4.1-flash"}';
    const res = new Response(raw, { status: 400 });
    const out = await parseUpstreamError(res);
    expect(out.message).toBe(raw);
    expect(out.message).not.toContain("[object Object]");
  });

  it("handles a non-JSON body", async () => {
    const res = new Response("upstream exploded", { status: 502 });
    const out = await parseUpstreamError(res);
    expect(out.message).toBe("upstream exploded");
  });

  it("coerces an object message returned by an executor parser", async () => {
    const res = new Response("ignored", { status: 429 });
    const executor = { parseError: () => ({ status: 429, message: { error: { message: "quota hit" } } }) };
    const out = await parseUpstreamError(res, executor);
    expect(out.message).toBe("quota hit");
  });
});

describe("formatProviderError", () => {
  it("keeps the cause suffix and stringifies the message", () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(formatProviderError(err, "opencode-go", "m", 502)).toBe("[502]: fetch failed (cause: ECONNRESET)");
  });

  it("does not throw when the error is a bare object", () => {
    const out = formatProviderError({ message: { error: { message: "weird" } } }, "p", "m", 400);
    expect(out).toBe("[400]: weird");
  });

  it("survives an undefined error", () => {
    expect(formatProviderError(undefined, "p", "m", 500)).toBe("[500]: Unknown error");
  });
});