import { describe, expect, it } from "vitest";
import { buildContentDigest } from "../../src/lib/usage/contentDigest.js";
import { mapHistoryRow, mergeUsageRows } from "../../src/lib/usage/mergeDetails.js";

describe("buildContentDigest", () => {
  it("summarizes messages, tools and the response", () => {
    const digest = buildContentDigest({
      request: {
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hello" },
          { role: "assistant", content: null, tool_calls: [{ function: { name: "read_file" } }] },
        ],
        tools: [{ function: { name: "read_file" } }, { type: "function", name: "grep" }],
      },
      response: { content: "hi there", thinking: "pondering", finish_reason: "stop" },
    });

    expect(digest.messageCount).toBe(3);
    expect(digest.messages[0]).toMatchObject({ role: "system", preview: "you are helpful" });
    expect(digest.messages[2].toolCalls).toEqual(["read_file"]);
    expect(digest.tools).toEqual(["read_file", "grep"]);
    expect(digest.response).toMatchObject({ contentChars: 8, preview: "hi there", thinkingChars: 9, finishReason: "stop" });
  });

  it("handles Responses API input items", () => {
    const digest = buildContentDigest({
      request: { input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }] },
    });
    expect(digest.messageCount).toBe(1);
    expect(digest.messages[0]).toMatchObject({ role: "user", preview: "ping" });
  });

  it("reports truncation and uses the stored preview", () => {
    const digest = buildContentDigest({
      request: { _truncated: true, _originalSize: 9000, _preview: '{"messages":[{"role":"user"' },
    });
    expect(digest.truncated).toBe(true);
    expect(digest.originalBytes).toBe(9000);
    expect(digest.truncatedPreview).toContain("messages");
  });

  it("clamps previews and reports character counts", () => {
    const long = "x".repeat(1000);
    const digest = buildContentDigest({ request: { messages: [{ role: "user", content: long }] } });
    expect(digest.messages[0].chars).toBe(1000);
    expect(digest.messages[0].preview.length).toBeLessThanOrEqual(241);
    expect(digest.messages[0].preview.endsWith("…")).toBe(true);
  });

  it("returns null when there is nothing to show", () => {
    expect(buildContentDigest(null)).toBeNull();
    expect(buildContentDigest({ request: {}, response: {} })).toBeNull();
  });
});

describe("mapHistoryRow", () => {
  it("maps usage history into the detail shape with token fallbacks", () => {
    const mapped = mapHistoryRow({
      timestamp: "2026-09-14T11:36:09.821Z",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      connectionId: "conn-1",
      status: "ok",
      cost: 0.01,
      promptTokens: 2021,
      completionTokens: 392,
      tokens: { reasoning_tokens: 331 },
    });
    expect(mapped).toMatchObject({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      status: "success",
      cost: 0.01,
      source: "history",
    });
    expect(mapped.tokens.prompt_tokens).toBe(2021);
    expect(mapped.tokens.completion_tokens).toBe(392);
    expect(mapped.tokens.reasoning_tokens).toBe(331);
  });
});

describe("mergeUsageRows", () => {
  it("prefers rich details on overlap and fills gaps from history", () => {
    const t = "2026-09-14T11:36:09.000Z";
    const details = [
      { id: "d1", timestamp: t, provider: "opencode-go", model: "mimo-v2.5", connectionId: "c1", tokens: { prompt_tokens: 5, completion_tokens: 1 }, latency: { total: 10 } },
    ];
    const history = [
      { timestamp: t, provider: "opencode-go", model: "mimo-v2.5", connectionId: "c1", status: "ok", tokens: { prompt_tokens: 5, completion_tokens: 1 } },
      { timestamp: "2026-09-14T11:35:00.000Z", provider: "opencode-go", model: "deepseek-v4.1-flash", connectionId: "c2", status: "ok", promptTokens: 111031, completionTokens: 953, tokens: { cached_tokens: 110464 } },
    ];
    const merged = mergeUsageRows(details, history);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: "d1", source: "detail" });
    expect(merged[1]).toMatchObject({ model: "deepseek-v4.1-flash", source: "history" });
    expect(merged[1].tokens.prompt_tokens).toBe(111031);
  });

  it("sorts newest first", () => {
    const merged = mergeUsageRows(
      [{ id: "old", timestamp: "2026-09-14T10:00:00.000Z" }],
      [{ timestamp: "2026-09-14T12:00:00.000Z", provider: "p", model: "m", status: "ok", tokens: {} }]
    );
    expect(merged[0].timestamp).toBe("2026-09-14T12:00:00.000Z");
  });
});
