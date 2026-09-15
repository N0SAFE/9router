import { describe, expect, it } from "vitest";
import {
  buildHeadroomTarget,
  getHeadroomPipelineContext,
  isHeadroomConnectError,
  isLocalOrPrivateHost,
  normalizeHeadroomUrl,
  runWithHeadroomPipeline,
} from "../../open-sse/services/headroomPipeline.js";

const HEADROOM = "http://127.0.0.1:8787/";

describe("normalizeHeadroomUrl", () => {
  it("trims and strips trailing slashes", () => {
    expect(normalizeHeadroomUrl(" http://localhost:8787/// ")).toBe("http://localhost:8787");
    expect(normalizeHeadroomUrl(undefined)).toBe("");
    expect(normalizeHeadroomUrl(42)).toBe("");
  });
});

describe("buildHeadroomTarget", () => {
  it("routes OpenCode Go chat completions with the /zen/go prefix preserved", () => {
    expect(buildHeadroomTarget("https://opencode.ai/zen/go/v1/chat/completions", HEADROOM)).toEqual({
      url: "http://127.0.0.1:8787/v1/chat/completions",
      upstreamBaseUrl: "https://opencode.ai/zen/go",
      originalPath: null,
    });
  });

  it("routes responses and messages paths", () => {
    expect(buildHeadroomTarget("https://opencode.ai/zen/go/v1/responses", HEADROOM)).toEqual({
      url: "http://127.0.0.1:8787/v1/responses",
      upstreamBaseUrl: "https://opencode.ai/zen/go",
      originalPath: null,
    });
    expect(buildHeadroomTarget("https://opencode.ai/zen/go/v1/messages", HEADROOM)).toEqual({
      url: "http://127.0.0.1:8787/v1/messages",
      upstreamBaseUrl: "https://opencode.ai/zen/go",
      originalPath: null,
    });
  });

  it("handles bare origins (standard OpenAI/Anthropic endpoints)", () => {
    expect(buildHeadroomTarget("https://api.openai.com/v1/chat/completions", HEADROOM)).toEqual({
      url: "http://127.0.0.1:8787/v1/chat/completions",
      upstreamBaseUrl: "https://api.openai.com",
      originalPath: null,
    });
    expect(buildHeadroomTarget("https://api.anthropic.com/v1/messages", HEADROOM)).toEqual({
      url: "http://127.0.0.1:8787/v1/messages",
      upstreamBaseUrl: "https://api.anthropic.com",
      originalPath: null,
    });
  });

  it("preserves query strings", () => {
    const target = buildHeadroomTarget("https://api.openai.com/v1/chat/completions?beta=true", HEADROOM);
    expect(target.url).toBe("http://127.0.0.1:8787/v1/chat/completions?beta=true");
    expect(target.upstreamBaseUrl).toBe("https://api.openai.com");
  });

  it("uses x-headroom-original-path for non-versioned custom gateways", () => {
    expect(buildHeadroomTarget("https://gateway.example.com/chat/completions", HEADROOM)).toEqual({
      url: "http://127.0.0.1:8787/v1/chat/completions",
      upstreamBaseUrl: "https://gateway.example.com",
      originalPath: "/chat/completions",
    });
    expect(buildHeadroomTarget("https://gateway.example.com/responses", HEADROOM)).toEqual({
      url: "http://127.0.0.1:8787/v1/responses",
      upstreamBaseUrl: "https://gateway.example.com",
      originalPath: "/responses",
    });
  });

  it("returns null for unsupported paths and invalid input", () => {
    expect(buildHeadroomTarget("https://api.example.com/v1/models", HEADROOM)).toBeNull();
    expect(buildHeadroomTarget("https://api.example.com/v1/messages/count_tokens", HEADROOM)).toBeNull();
    expect(buildHeadroomTarget("not a url", HEADROOM)).toBeNull();
    expect(buildHeadroomTarget("file:///tmp/x/v1/chat/completions", HEADROOM)).toBeNull();
    expect(buildHeadroomTarget("https://api.openai.com/v1/chat/completions", "")).toBeNull();
  });
});

describe("isLocalOrPrivateHost", () => {
  it("flags loopback, link-local and RFC1918 hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "0.0.0.0", "10.1.2.3", "192.168.1.10", "172.16.0.9", "172.31.255.1", "169.254.1.1", "box.local"]) {
      expect(isLocalOrPrivateHost(host), host).toBe(true);
    }
  });

  it("allows public hosts", () => {
    for (const host of ["opencode.ai", "api.openai.com", "172.32.0.1", "172.15.0.1", "8.8.8.8"]) {
      expect(isLocalOrPrivateHost(host), host).toBe(false);
    }
  });

  it("skips pipeline routing for local upstreams", () => {
    expect(buildHeadroomTarget("http://127.0.0.1:11434/v1/chat/completions", HEADROOM)).toBeNull();
    expect(buildHeadroomTarget("http://192.168.1.50:8000/v1/chat/completions", HEADROOM)).toBeNull();
  });
});

describe("runWithHeadroomPipeline", () => {
  it("exposes the context only inside the wrapped call", () => {
    expect(getHeadroomPipelineContext()).toBeNull();
    const ctx = runWithHeadroomPipeline({ url: HEADROOM }, () => getHeadroomPipelineContext());
    expect(ctx).toEqual({ url: "http://127.0.0.1:8787" });
    expect(getHeadroomPipelineContext()).toBeNull();
  });

  it("runs the function directly when no URL is configured", () => {
    const result = runWithHeadroomPipeline({ url: "" }, () => {
      expect(getHeadroomPipelineContext()).toBeNull();
      return "ok";
    });
    expect(result).toBe("ok");
  });
});

describe("isHeadroomConnectError", () => {
  it("detects connection failures", () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(isHeadroomConnectError(refused)).toBe(true);
    expect(isHeadroomConnectError(new Error("fetch failed"))).toBe(true);
  });

  it("does not retry aborts or HTTP errors", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError", cause: { code: "ECONNREFUSED" } });
    expect(isHeadroomConnectError(abort)).toBe(false);
    expect(isHeadroomConnectError(new Error("HTTP 500 from Headroom"))).toBe(false);
    expect(isHeadroomConnectError(null)).toBe(false);
  });
});
