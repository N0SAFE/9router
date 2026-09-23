import { describe, expect, it } from "vitest";
import {
  budgetProgress,
  buildSessionTurns,
  detectSpikes,
  groupImplicitSessions,
  lastRealUserText,
  sessionIdOf,
  summarizeSession,
} from "../../src/lib/usage/sessions.js";

function detail({ id, ts, user, assistant, tokens, cost, ttft, total, sessionId, toolCalls = null, provider = "opencode-go", model = "deepseek-v4.1-flash" }) {
  const messages = [
    ...(user ? [{ role: "user", content: user }] : []),
  ];
  return {
    id,
    timestamp: ts,
    provider,
    model,
    connectionId: "conn-1",
    status: "success",
    sessionId: sessionId || null,
    cost,
    latency: { ttft, total },
    tokens,
    request: { messages, metadata: sessionId ? { sessionId } : {} },
    response: { content: assistant ?? "ok", thinking: null, finish_reason: "stop" },
    routing: toolCalls ? { attempts: [] } : null,
  };
}

const baseTokens = { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 400, reasoning_tokens: 0 };

describe("session analytics", () => {
  it("prefers the explicit session id (column or metadata)", () => {
    expect(sessionIdOf({ sessionId: "s1" })).toBe("s1");
    expect(sessionIdOf({ request: { metadata: { sessionId: "s2" } } })).toBe("s2");
    expect(sessionIdOf({ request: { metadata: {} } })).toBeNull();
  });

  it("groups id-less details into implicit sessions and splits on idle gaps", () => {
    const t0 = "2026-09-22T10:00:00.000Z";
    const t1 = "2026-09-22T10:05:00.000Z";
    const t2 = "2026-09-22T12:00:00.000Z"; // > idle window
    const details = [
      detail({ id: "a", ts: t0, user: "hello", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 3000 }),
      detail({ id: "b", ts: t1, user: "hello", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 3000 }),
      detail({ id: "c", ts: t2, user: "hello", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 3000 }),
    ];
    const groups = groupImplicitSessions(details);
    expect(groups).toHaveLength(2);
    expect(groups[0].details.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(groups[1].details.map((entry) => entry.id)).toEqual(["c"]);
    // A different first user message starts a different session.
    const other = groupImplicitSessions([
      ...details.slice(0, 1),
      detail({ id: "d", ts: t1, user: "different question", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 3000 }),
    ]);
    expect(other).toHaveLength(2);
  });

  it("builds turns with chat deltas, speeds and running totals", () => {
    const turns = buildSessionTurns([
      detail({ id: "t1", ts: "2026-09-22T10:00:00.000Z", user: "first", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 3000 }),
      detail({ id: "t2", ts: "2026-09-22T10:01:00.000Z", user: "first", tokens: { ...baseTokens, prompt_tokens: 1500 }, cost: 0.02, ttft: 2000, total: 5000 }),
    ]);
    expect(turns).toHaveLength(2);
    // 200 output tokens over (3000-1000)ms.
    expect(turns[0].outputSpeed).toBeCloseTo(100, 5);
    expect(turns[0].inputSpeed).toBeCloseTo(1000, 5);
    expect(turns[0].cumulativeCostUsd).toBeCloseTo(0.01, 6);
    expect(turns[1].cumulativeCostUsd).toBeCloseTo(0.03, 6);
    expect(turns[1].cumulativeTokens).toBe(2900);
  });

  it("flags cost and token spikes against the session median", () => {
    const turns = buildSessionTurns([
      detail({ id: "a", ts: "2026-09-22T10:00:00.000Z", user: "q", tokens: { ...baseTokens, completion_tokens: 100 }, cost: 0.001, ttft: 500, total: 1500 }),
      detail({ id: "b", ts: "2026-09-22T10:01:00.000Z", user: "q", tokens: { ...baseTokens, completion_tokens: 100 }, cost: 0.001, ttft: 500, total: 1500 }),
      detail({ id: "c", ts: "2026-09-22T10:02:00.000Z", user: "q", tokens: { prompt_tokens: 200000, completion_tokens: 50000 }, cost: 0.5, ttft: 5000, total: 20000 }),
    ]);
    const { flagged, costMedian } = detectSpikes(turns);
    expect(costMedian).toBeCloseTo(0.001, 6);
    expect(flagged.map((entry) => entry.turnId)).toContain("c");
    expect(flagged[0].flags.map((flag) => flag.code)).toContain("cost_spike");
  });

  it("keeps concurrent sessions apart even with the same first prompt", () => {
    const details = [
      detail({ id: "a", ts: "2026-09-22T10:00:00.000Z", user: "same prompt", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 30000 }),
      // Starts while the first request is still generating: a different session.
      detail({ id: "b", ts: "2026-09-22T10:00:10.000Z", user: "same prompt", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 30000 }),
    ];
    const groups = groupImplicitSessions(details);
    expect(groups).toHaveLength(2);
  });

  it("registers in-flight sessions for attach-before-first-turn", async () => {
    const { registerSessionStart, listLiveSessions, findGeneratingSession } = await import("../../src/lib/usage/liveSessions.js");
    registerSessionStart({ sessionId: "live-test-explicit", label: "explicit", provider: "p", model: "m" });
    expect(findGeneratingSession({ sessionId: "live-test-explicit" })?.generating).toBe(true);
    registerSessionStart({ liveKey: "live-test-key", label: "implicit" });
    expect(findGeneratingSession({ liveKey: "live-test-key" })?.id).toBe("live:live-test-key");
    expect(listLiveSessions().some((entry) => entry.id === "live:live-test-key")).toBe(true);
  });

  it("summarizes a session and computes budget progress", () => {
    const details = [
      detail({ id: "a", ts: "2026-09-22T10:00:00.000Z", user: "hello world", tokens: baseTokens, cost: 0.01, ttft: 1000, total: 3000 }),
      detail({ id: "b", ts: "2026-09-22T10:01:00.000Z", user: "hello world", tokens: baseTokens, cost: 0.02, ttft: 1000, total: 3000 }),
    ];
    const summary = summarizeSession(details);
    expect(summary.requests).toBe(2);
    expect(summary.costUsd).toBeCloseTo(0.03, 6);
    expect(summary.label).toContain("hello world");
    const progress = budgetProgress(summary, { costUsd: 0.06, tokens: null });
    expect(progress.costPct).toBeCloseTo(50, 1);
    expect(progress.exceeded).toBe(false);
    expect(budgetProgress(summary, { costUsd: 0.01 }).exceeded).toBe(true);
  });
});

describe("tool calls and tool results", () => {
  const tokens = { prompt_tokens: 900, completion_tokens: 120, cached_tokens: 0, reasoning_tokens: 0 };
  const base = (id, ts, request, response) => ({
    id,
    timestamp: ts,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    status: "success",
    tokens,
    latency: { ttft: 120, total: 900 },
    request,
    response,
  });

  it("hides Anthropic tool_result user messages and attaches them to the call", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T10:00:00Z",
        { messages: [{ role: "user", content: "What is the weather in Paris?" }] },
        { content: "[Empty streaming response]", toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }] }
      ),
      base(
        "d2",
        "2026-01-01T10:00:05Z",
        {
          messages: [
            { role: "user", content: "What is the weather in Paris?" },
            { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "get_weather", input: { city: "Paris" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "18C and sunny" }] },
          ],
        },
        { content: "It is 18C and sunny in Paris." }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].userMessages).toHaveLength(1);
    expect(turns[0].userMessages[0].text).toContain("weather in Paris");
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].result).toContain("18C and sunny");
    expect(turns[0].assistant.content).toBeNull();

    // The tool result must not surface as a user bubble or a standalone row.
    expect(turns[1].userMessages).toHaveLength(0);
    expect(turns[1].toolMessages).toHaveLength(0);
    expect(turns[1].assistant.content).toContain("18C and sunny");
  });

  it("attaches role:tool results to the call and keeps them out of user messages", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T11:00:00Z",
        { messages: [{ role: "user", content: "weather?" }] },
        { content: null, toolCalls: [{ name: "get_weather", arguments: "{}" }] }
      ),
      base(
        "d2",
        "2026-01-01T11:00:03Z",
        {
          messages: [
            { role: "user", content: "weather?" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "call_1", content: "rain" },
          ],
        },
        { content: "It rains." }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].toolCalls[0].result).toBe("rain");
    expect(turns[1].userMessages).toHaveLength(0);
    expect(turns[1].toolMessages).toHaveLength(0);
  });

  it("keeps unmatched tool results as tool rows, never user bubbles", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T12:00:00Z",
        {
          messages: [
            { role: "user", content: "hi" },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan result" }] },
          ],
        },
        { content: "hello" }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].userMessages).toHaveLength(1);
    expect(turns[0].userMessages[0].text).toBe("hi");
    expect(turns[0].toolMessages).toHaveLength(1);
    expect(turns[0].toolMessages[0].text).toBe("orphan result");
  });

  it("keeps real user text when a message mixes text and a tool result", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T13:00:00Z",
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu9", content: "42" },
                { type: "text", text: "and now explain that number" },
              ],
            },
          ],
        },
        { content: "Sure." }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].userMessages.map((message) => message.text)).toEqual(["hello", "and now explain that number"]);
    expect(turns[0].toolMessages).toHaveLength(1);
    expect(turns[0].toolMessages[0].text).toBe("42");
  });

  it("hides system prompts from the chat and keeps orphan results visible", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T14:00:00Z",
        {
          messages: [
            { role: "system", content: "Respond tersely. No filler." },
            { role: "user", content: "ping" },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan tool output" }] },
          ],
        },
        { content: "pong" }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].userMessages.map((message) => message.text)).toEqual(["ping"]);
    expect(turns[0].toolMessages.map((message) => message.text)).toEqual(["orphan tool output"]);
  });

  it("hides context-only user messages entirely", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T15:00:00Z",
        {
          messages: [
            {
              role: "user",
              content: "<context>\nThe current date is 2026-09-23.\nTerminals: zsh\n</context>",
            },
          ],
        },
        { content: "ok" }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].userMessages).toHaveLength(0);
    expect(turns[0].toolMessages).toHaveLength(0);
  });

  it("treats plain-text tool output after a tool call as a tool result", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T16:00:00Z",
        { messages: [{ role: "user", content: "run the typechecks" }] },
        { content: "[Empty streaming response]", toolCalls: [{ name: "run_in_terminal", arguments: '{"command":"bun type-check"}' }] }
      ),
      base(
        "d2",
        "2026-01-01T16:00:04Z",
        {
          messages: [
            { role: "user", content: "run the typechecks" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", function: { name: "run_in_terminal", arguments: '{"command":"bun type-check"}' } }],
            },
            {
              role: "user",
              content: "<context>\nThe current date is 2026-09-23.\nTerminals: zsh\n</context>\n\napi=0\nsetup=1\nlifecycle=0",
            },
          ],
        },
        { content: "typechecks done" }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].toolCalls[0].result).toContain("api=0");
    expect(turns[1].userMessages).toHaveLength(0);
    expect(turns[1].toolMessages).toHaveLength(0);
    expect(turns[1].assistant.content).toBe("typechecks done");
  });

  it("keeps real user text that follows a context block", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T17:00:00Z",
        {
          messages: [
            {
              role: "user",
              content: "<context>\nignored preamble\n</context>\n\nplease fix the failing test",
            },
          ],
        },
        { content: "on it" }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].userMessages).toHaveLength(1);
    expect(turns[0].userMessages[0].text).toContain("fix the failing test");
    expect(lastRealUserText([{ role: "user", content: "<context>x</context>" }])).toBeNull();
    expect(lastRealUserText([{ role: "user", content: "<context>x</context>\n\nreal ask" }])).toContain("real ask");
  });

  it("treats text after an empty tool placeholder row as the tool result", () => {
    const details = [
      base(
        "d1",
        "2026-01-01T18:00:00Z",
        {
          messages: [
            { role: "system", content: "agent prompt" },
            { role: "user", content: "run the typechecks" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", function: { name: "run_in_terminal", arguments: "{}" } }],
            },
            { role: "tool", tool_call_id: "call_1", content: "" },
            { role: "user", content: "<context>\nTerminals: zsh\n</context>\n\napi=0\nsetup=1" },
          ],
        },
        { content: "done" }
      ),
    ];

    const turns = buildSessionTurns(details);
    expect(turns[0].userMessages.map((message) => message.text)).toEqual(["run the typechecks"]);
    expect(turns[0].toolMessages.map((message) => message.text)).toEqual(["api=0\nsetup=1"]);
  });
});
