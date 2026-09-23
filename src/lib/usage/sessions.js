/**
 * Session analytics for the Sessions tab.
 *
 * A "session" is a conversation: either explicit (the client sent a session id
 * through metadata/headers) or implicit (grouped by API key + provider + model
 * + the first user message, split after an idle gap). Everything here is pure
 * so it can be unit tested and reused by the API and the SSE stream.
 */

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const TOOL_ROLES = new Set(["tool", "function"]);

/* --------------------------------- helpers -------------------------------- */

export function sessionIdOf(detail) {
  const explicit =
    (typeof detail?.sessionId === "string" && detail.sessionId.trim()) ||
    (typeof detail?.request?.metadata?.sessionId === "string" && detail.request.metadata.sessionId.trim()) ||
    (typeof detail?.request?.metadata?.conversationId === "string" && detail.request.metadata.conversationId.trim());
  return explicit || null;
}

export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        if (part?.type === "image" || part?.type === "image_url") return "[image]";
        if (part?.type === "tool_result" || part?.type === "tool_use") return "";
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Split a user-role message into real user text and tool results. Anthropic
 * style clients send tool results as `role: "user"` with `tool_result` parts;
 * those must never surface as user bubbles in the chat.
 */
export function splitUserContent(message) {
  const content = message?.content;
  if (typeof content === "string") return { text: content.trim(), toolResults: [] };
  if (!Array.isArray(content)) return { text: "", toolResults: [] };
  const textParts = [];
  const toolResults = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "tool_result") {
      const text = typeof part.content === "string"
        ? part.content
        : Array.isArray(part.content)
          ? part.content.map((inner) => (typeof inner === "string" ? inner : inner?.text || "")).join("\n")
          : "";
      toolResults.push({ text: text.slice(0, 4000), id: part.tool_use_id || null, isError: part.is_error === true });
      continue;
    }
    if (part.type === "tool_use") continue;
    if (typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "image" || part.type === "image_url") textParts.push("[image]");
  }
  return { text: textParts.filter(Boolean).join("\n").trim(), toolResults };
}

const CONTEXT_BLOCK = /^\s*(?:<([a-z_][a-z0-9_-]*)>[\s\S]*?<\/\1>\s*)+/i;

/** Drop leading environment/context blocks: they are injected, not user text. */
export function stripContextBlocks(text) {
  let value = String(text || "");
  for (;;) {
    const match = CONTEXT_BLOCK.exec(value);
    if (!match) break;
    value = value.slice(match[0].length);
  }
  // Stored payloads are truncated, so a context block can arrive without its
  // closing tag: drop the opener anyway.
  const unclosed = /^\s*<([a-z_][a-z0-9_-]*)>([\s\S]*)$/i.exec(value);
  if (unclosed) value = unclosed[2];
  return value;
}

/** User text without injected context blocks. */
export function cleanUserText(text) {
  return stripContextBlocks(text).trim();
}

function isToolCallMessage(message) {
  return message?.role === "assistant" && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

/**
 * Walk a message batch and split it the way a chat client shows it: real user
 * messages on one side, tool results (structured or plain-text replies to a
 * tool call) on the other.
 */
function classifyMessages(messages = []) {
  const userMessages = [];
  const toolResults = [];
  // True while a tool output is expected: right after a tool call, or after an
  // empty tool placeholder row (some clients emit one before the real output).
  let expectingToolOutput = false;

  for (const message of messages) {
    if (TOOL_ROLES.has(message?.role)) {
      const text = messageText(message).slice(0, 4000);
      if (text) {
        toolResults.push({ text, name: message?.name || null, id: message?.tool_call_id || null });
        expectingToolOutput = false;
      } else {
        // Placeholder row: the real output usually follows as a user message.
        expectingToolOutput = true;
      }
      continue;
    }
    if (message?.role === "user") {
      const { text, toolResults: parts } = splitUserContent(message);
      for (const part of parts) toolResults.push(part);
      const cleaned = cleanUserText(text);
      if (cleaned) {
        if (expectingToolOutput && parts.length === 0) {
          // Clients with no tool role send the tool output as a plain user
          // message after the call: it is a result, not the user.
          toolResults.push({ text: cleaned.slice(0, 4000), name: null, id: message?.tool_call_id || null });
        } else {
          // Keep the raw text: the UI collapses leading context blocks itself.
          userMessages.push({ role: "user", text: text.trim() });
        }
      }
      expectingToolOutput = false;
      continue;
    }
    expectingToolOutput = isToolCallMessage(message);
  }

  return { userMessages, toolResults };
}

/** Last real user message in a request (never context blocks or tool output). */
export function lastRealUserText(messages = []) {
  const { userMessages } = classifyMessages(messages);
  return userMessages.length > 0 ? userMessages[userMessages.length - 1].text : null;
}

function messageSignature(message) {
  return `${message?.role || "?"}:${messageText(message).slice(0, 200)}:${Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0}`;
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
}

function fingerprintOf(detail) {
  const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
  const firstUser = messages.find((message) => message?.role === "user");
  const seed = `${detail?.provider || ""}|${detail?.model || ""}|${messageText(firstUser).slice(0, 300)}`;
  return `${detail?.provider || "unknown"}|${hashText(seed)}`;
}

/**
 * Loose identity used to attach in-flight requests to a session before the
 * provider/model resolution is known. Request details do not store the API key,
 * so the identity is the first user message alone.
 */
export function liveKeyForDetail(detail) {
  const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
  const firstUser = messages.find((message) => message?.role === "user");
  return hashText(messageText(firstUser).slice(0, 300));
}

export function liveKeyForRequest({ messages } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const firstUser = list.find((message) => message?.role === "user");
  return hashText(messageText(firstUser).slice(0, 300));
}

function tokenMetrics(detail) {
  const tokens = detail?.tokens || {};
  const input = Number(tokens.prompt_tokens ?? tokens.input_tokens) || 0;
  const cached = Number(tokens.cached_tokens ?? tokens.cache_read_input_tokens) || 0;
  const output = Number(tokens.completion_tokens ?? tokens.output_tokens) || 0;
  const reasoning = Number(tokens.reasoning_tokens) || 0;
  const cacheWrite = Number(tokens.cache_creation_input_tokens) || 0;
  return { input, cached, output, reasoning, cacheWrite, total: input + output };
}

function toolCallsFrom(messages = []) {
  const calls = [];
  for (const message of messages) {
    if (!Array.isArray(message?.tool_calls)) continue;
    for (const call of message.tool_calls) {
      calls.push({
        name: call?.function?.name || call?.name || "tool",
        args: call?.function?.arguments || null,
      });
    }
  }
  return calls;
}

/* ------------------------------ implicit groups ---------------------------- */

/**
 * Group details that carry no session id into implicit sessions:
 * same API key + provider + conversation fingerprint, split after `idleMs`.
 */
export function groupImplicitSessions(details = [], { idleMs = DEFAULT_IDLE_MS } = {}) {
  const sorted = [...details].sort((a, b) => new Date(a?.timestamp || 0) - new Date(b?.timestamp || 0));
  const buckets = [];
  const openBucketByKey = new Map();

  for (const detail of sorted) {
    if (sessionIdOf(detail)) continue;
    if (!detail?.timestamp) continue;
    const mergeKey = mergeKeyForDetail(detail);
    const time = new Date(detail.timestamp).getTime();
    const open = openBucketByKey.get(mergeKey);
    // A bucket continues only when the request extends the same conversation
    // (its history starts with the previous request's messages) and does not
    // overlap it in time — that keeps two concurrent sessions apart even when
    // they send the same first prompt.
    const continues = open && time - open.lastAt <= idleMs && conversationContinues(open, detail) && !overlapsInFlight(open, detail);
    if (continues) {
      open.details.push(detail);
      open.lastAt = time;
    } else {
      const bucket = { key: mergeKey, mergeKey, startedAt: detail.timestamp, lastAt: time, details: [detail] };
      openBucketByKey.set(mergeKey, bucket);
      buckets.push(bucket);
    }
  }

  return buckets.map((bucket) => ({
    id: `implicit:${bucket.mergeKey}:${bucket.startedAt}`,
    mergeKey: bucket.mergeKey,
    liveKey: liveKeyForDetail(bucket.details[0]),
    kind: "implicit",
    details: bucket.details,
  }));
}

/** Stable key for an implicit conversation: api key + provider/model + history fingerprint. */
export function mergeKeyForDetail(detail) {
  return `${detail?.apiKey || "nokey"}|${fingerprintOf(detail)}`;
}

/** Same key computed from a request body (used to register in-flight sessions). */
export function mergeKeyForRequest({ apiKey, provider, model, messages }) {
  return `${apiKey || "nokey"}|${fingerprintOf({ provider, model, request: { messages } })}`;
}

/** The new request's history must start with the previous request's messages. */
function conversationContinues(bucket, detail) {
  const previous = bucket.details[bucket.details.length - 1];
  const prevMessages = Array.isArray(previous?.request?.messages) ? previous.request.messages : [];
  const nextMessages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
  if (prevMessages.length === 0) return true;
  if (nextMessages.length < prevMessages.length) return false;
  for (let index = 0; index < prevMessages.length; index += 1) {
    if (messageSignature(prevMessages[index]) !== messageSignature(nextMessages[index])) return false;
  }
  return true;
}

/** A request that starts before the previous one finished belongs to another session. */
function overlapsInFlight(bucket, detail) {
  const previous = bucket.details[bucket.details.length - 1];
  const prevStart = previous?.timestamp ? new Date(previous.timestamp).getTime() : 0;
  const prevTotal = Number(previous?.latency?.total) || 0;
  const nextStart = detail?.timestamp ? new Date(detail.timestamp).getTime() : 0;
  if (!prevStart || !nextStart || prevTotal <= 0) return false;
  return nextStart < prevStart + prevTotal;
}

export function implicitSessionMatches(sessionId, group) {
  return group.id === sessionId;
}

/* ---------------------------------- turns --------------------------------- */

/**
 * Build per-request turns with metrics, chat deltas, tool calls and running
 * totals. `details` must be oldest-first.
 */
export function buildSessionTurns(details = []) {
  // Pass 1: the messages each request added to the history.
  const batches = details.map((detail, index) => {
    const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
    const previous = index > 0 && Array.isArray(details[index - 1]?.request?.messages)
      ? details[index - 1].request.messages
      : [];
    const fresh = messages.filter((message, position) => {
      if (position >= previous.length) return true;
      return messageSignature(message) !== messageSignature(previous[position]);
    });
    // Classify once: the same result objects are later marked as consumed.
    const classification = classifyMessages(fresh);
    return { messages, fresh, results: classification.toolResults, userMessages: classification.userMessages };
  });

  // Tool results already attached to a previous turn's tool calls must not show
  // up again as standalone rows.
  const consumed = batches.map(() => new Set());
  const turns = [];
  let cumulativeTokens = 0;
  let cumulativeCost = 0;

  details.forEach((detail, index) => {
    const { fresh } = batches[index];
    const tokens = tokenMetrics(detail);
    const costUsd = Number(detail?.cost) || 0;
    const ttft = Number(detail?.latency?.ttft) || 0;
    const total = Number(detail?.latency?.total) || 0;

    const userMessages = batches[index].userMessages;

    // Tool calls this turn produced live in the NEXT request's history.
    const nextMessages = Array.isArray(details[index + 1]?.request?.messages)
      ? details[index + 1].request.messages
      : [];
    const assistantIndex = nextMessages.findIndex((message) => message?.role === "assistant" && Array.isArray(message.tool_calls));
    // Prefer the tool calls recorded with the response; the next-request
    // heuristic misses the last turn of a session.
    const recordedToolCalls = Array.isArray(detail?.response?.toolCalls)
      ? detail.response.toolCalls.filter((call) => call && (call.name || call.arguments))
      : [];
    const baseCalls = recordedToolCalls.length > 0
      ? recordedToolCalls.map((call) => ({ name: call.name || "tool", arguments: call.arguments || null }))
      : assistantIndex >= 0
        ? toolCallsFrom([nextMessages[assistantIndex]])
        : [];

    // Results of those calls arrive with the next request: attach them here so
    // the chat shows the call and its result as one exchange. Only results that
    // matched a call are consumed, so orphans still surface as tool rows.
    const nextBatch = batches[index + 1];
    const nextResults = nextBatch?.results || [];
    const matchedResults = nextResults.slice(0, baseCalls.length);
    for (const result of matchedResults) consumed[index + 1].add(result);
    const toolCalls = baseCalls.map((call, position) => ({
      ...call,
      result: matchedResults[position]?.text || null,
      resultName: matchedResults[position]?.name || null,
      resultIsError: matchedResults[position]?.isError === true,
    }));

    // Standalone tool results (no matching call, or calls not recorded).
    const toolMessages = batches[index].results
      .filter((result) => !consumed[index].has(result))
      .map((result) => ({
        role: "tool",
        text: result.text,
        name: result.name || null,
        toolCallId: result.id || null,
      }));

    const response = detail?.response || {};
    const rawContent = typeof response?.content === "string" ? response.content : response?.content ?? null;
    // A tool-calling turn has no text: keep it null instead of a placeholder.
    const assistantContent = rawContent === "[Empty streaming response]" && toolCalls.length > 0 ? null : rawContent;
    let inputSpeed = null;
    let outputSpeed = null;
    if (ttft > 0 && tokens.input > 0) inputSpeed = tokens.input / (ttft / 1000);
    const generationMs = total > 0 ? (ttft > 0 && total > ttft ? total - ttft : total) : 0;
    if (generationMs > 0 && tokens.output > 0) outputSpeed = tokens.output / (generationMs / 1000);

    cumulativeTokens += tokens.total + tokens.reasoning;
    cumulativeCost += costUsd;

    turns.push({
      index,
      id: detail?.id || null,
      timestamp: detail?.timestamp || null,
      provider: detail?.provider || null,
      model: detail?.model || null,
      connectionId: detail?.connectionId || null,
      status: detail?.status || "success",
      tokens,
      costUsd,
      ttft: ttft > 0 ? ttft : null,
      total: total > 0 ? total : null,
      inputSpeed,
      outputSpeed,
      toolCalls,
      userMessages,
      toolMessages,
      assistant: typeof rawContent === "string" || rawContent !== undefined
        ? { content: assistantContent, thinking: response.thinking ?? null, finishReason: response.finish_reason ?? null }
        : null,
      routing: detail?.routing || null,
      cacheHitRate: tokens.input > 0 ? tokens.cached / tokens.input : null,
      cumulativeTokens,
      cumulativeCostUsd: cumulativeCost,
      flags: [],
    });
  });

  return turns;
}

/* ---------------------------------- spikes -------------------------------- */

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Flag turns that consume far more than the session's typical turn.
 * Relative (vs median) and absolute thresholds both apply when provided.
 */
export function detectSpikes(turns = [], options = {}) {
  const {
    costMultiplier = 3,
    tokenMultiplier = 3,
    minCostUsd = 0.01,
    minTokens = 5000,
    absoluteCostUsd = null,
    absoluteTokens = null,
  } = options;

  const costMedian = median(turns.map((turn) => turn.costUsd).filter((value) => value > 0));
  const tokenMedian = median(turns.map((turn) => turn.tokens.total).filter((value) => value > 0));
  const flagged = [];

  for (const turn of turns) {
    const flags = [];
    const costRatio = costMedian > 0 ? turn.costUsd / costMedian : 0;
    const tokenRatio = tokenMedian > 0 ? turn.tokens.total / tokenMedian : 0;

    if (absoluteCostUsd !== null && turn.costUsd >= absoluteCostUsd) {
      flags.push({ code: "cost_absolute", ratio: costRatio, message: `Cost $${turn.costUsd.toFixed(4)} crossed the absolute limit ($${absoluteCostUsd}).` });
    } else if (costMedian > 0 && costRatio >= costMultiplier && turn.costUsd >= minCostUsd) {
      flags.push({ code: "cost_spike", ratio: costRatio, message: `Cost is ${costRatio.toFixed(1)}× this session's median turn.` });
    }

    if (absoluteTokens !== null && turn.tokens.total >= absoluteTokens) {
      flags.push({ code: "token_absolute", ratio: tokenRatio, message: `${turn.tokens.total.toLocaleString()} tokens crossed the absolute limit (${absoluteTokens.toLocaleString()}).` });
    } else if (tokenMedian > 0 && tokenRatio >= tokenMultiplier && turn.tokens.total >= minTokens) {
      flags.push({ code: "token_spike", ratio: tokenRatio, message: `Token usage is ${tokenRatio.toFixed(1)}× this session's median turn.` });
    }

    turn.flags = flags;
    if (flags.length > 0) {
      flagged.push({ turnId: turn.id, index: turn.index, timestamp: turn.timestamp, flags });
    }
  }

  return { flagged, costMedian, tokenMedian };
}

/* -------------------------------- summary --------------------------------- */

function firstUserMessage(detail) {
  const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
  const user = messages.find((message) => message?.role === "user");
  return messageText(user);
}

const LABEL_NOISE = [
  /^<environment_info>/i,
  /^<system/i,
  /^<[a-z_]+>[\s\S]*<\/[a-z_]+>$/i,
  // Harness context blocks (often truncated, so match on the opening line).
  /^<[a-z_][a-z0-9_-]*>/i,
  /^i am working in a workspace/i,
  /^the user'?s current (os|operating system)/i,
  /^terminals?:\s*$/im,
];
const NOISE_BLOCK = /<([a-z_]+)>[\s\S]*?<\/\1>/gi;

/**
 * First-line label for a session: strips leading context blocks
 * (environment/workspace info) and rejects messages that are pure noise.
 */
export function sanitizeLabel(text, fallback = null) {
  const value = String(text || "").trim();
  if (!value) return fallback;
  const stripped = value.replace(NOISE_BLOCK, " ").replace(/\s+/g, " ").trim();
  const candidate = stripped.length >= 8 ? stripped : value;
  if (LABEL_NOISE.some((pattern) => pattern.test(candidate))) return fallback;
  return candidate.slice(0, 96);
}

/** First meaningful user message across the session, with a model fallback. */
function pickLabel(details) {
  for (const detail of details) {
    const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
    for (const message of messages) {
      if (message?.role !== "user") continue;
      const text = messageText(message).trim();
      const label = sanitizeLabel(text);
      if (!label) continue;
      return label;
    }
  }
  const first = details[0];
  const model = first?.model ? `${first.provider ? `${first.provider}/` : ""}${first.model}` : "request";
  const when = first?.timestamp
    ? new Date(first.timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : "";
  return `${model}${when ? ` · ${when}` : ""}`;
}

export function summarizeSession(details = []) {
  const sorted = [...details].sort((a, b) => new Date(a?.timestamp || 0) - new Date(b?.timestamp || 0));
  const first = sorted[0] || null;
  const last = sorted[sorted.length - 1] || null;
  const providers = new Set();
  const models = new Set();
  let tokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let failures = 0;

  for (const detail of sorted) {
    const metrics = tokenMetrics(detail);
    tokens += metrics.total + metrics.reasoning;
    cachedTokens += metrics.cached;
    costUsd += Number(detail?.cost) || 0;
    if (detail?.status && !["ok", "success"].includes(detail.status)) failures += 1;
    if (detail?.provider) providers.add(detail.provider);
    if (detail?.model) models.add(detail.model);
  }

  const label = pickLabel(sorted);

  return {
    label,
    startedAt: first?.timestamp || null,
    lastAt: last?.timestamp || null,
    requests: sorted.length,
    failures,
    tokens,
    cachedTokens,
    costUsd,
    providers: [...providers],
    models: [...models],
    apiKey: first?.apiKey || null,
    connectionId: last?.connectionId || null,
    kinds: [...new Set(sorted.map((detail) => detail?.request?.endpoint || detail?.endpoint).filter(Boolean))],
  };
}

/** Budget progress for the session header (percent + exceeded flags). */
export function budgetProgress(summary, budget) {
  if (!budget || (budget.costUsd == null && budget.tokens == null)) return null;
  const costPct = budget.costUsd ? (summary.costUsd / budget.costUsd) * 100 : null;
  const tokenPct = budget.tokens ? (summary.tokens / budget.tokens) * 100 : null;
  return {
    costPct,
    tokenPct,
    exceeded: (costPct !== null && costPct >= 100) || (tokenPct !== null && tokenPct >= 100),
    near: (costPct !== null && costPct >= 80) || (tokenPct !== null && tokenPct >= 80),
  };
}
