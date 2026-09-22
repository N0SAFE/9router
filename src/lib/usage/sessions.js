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

function messageSignature(message) {
  return `${message?.role || "?"}:${messageText(message).slice(0, 200)}:${Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0}`;
}

function fingerprintOf(detail) {
  const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
  const firstUser = messages.find((message) => message?.role === "user");
  const seed = `${detail?.provider || ""}|${detail?.model || ""}|${messageText(firstUser).slice(0, 300)}|${detail?.request?.metadata?.clientRequestId ? "" : ""}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return `${detail?.provider || "unknown"}|${hash.toString(36)}`;
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
    const key = `${detail?.apiKey || "nokey"}|${fingerprintOf(detail)}`;
    const time = new Date(detail.timestamp).getTime();
    const open = openBucketByKey.get(key);
    if (open && time - open.lastAt <= idleMs) {
      open.details.push(detail);
      open.lastAt = time;
    } else {
      const bucket = { key, startedAt: detail.timestamp, lastAt: time, details: [detail] };
      openBucketByKey.set(key, bucket);
      buckets.push(bucket);
    }
  }

  return buckets.map((bucket) => ({
    id: `implicit:${bucket.key}:${bucket.startedAt}`,
    kind: "implicit",
    details: bucket.details,
  }));
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
  const turns = [];
  let previousMessages = [];
  let cumulativeTokens = 0;
  let cumulativeCost = 0;

  details.forEach((detail, index) => {
    const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
    const tokens = tokenMetrics(detail);
    const costUsd = Number(detail?.cost) || 0;
    const ttft = Number(detail?.latency?.ttft) || 0;
    const total = Number(detail?.latency?.total) || 0;

    // New messages for this turn = the history added since the previous request.
    const previousSignatures = previousMessages.map(messageSignature);
    const newMessages = messages.filter((message, position) => {
      const signature = messageSignature(message);
      return position >= previousMessages.length || previousSignatures[position] !== signature;
    });
    const userMessages = newMessages
      .filter((message) => message?.role === "user" || message?.role === "system")
      .map((message) => ({ role: message.role, text: messageText(message) }));
    const toolMessages = newMessages
      .filter((message) => TOOL_ROLES.has(message?.role))
      .map((message) => ({ role: "tool", text: messageText(message).slice(0, 2000) }));

    // Tool calls this turn produced live in the NEXT request's history.
    const nextMessages = Array.isArray(details[index + 1]?.request?.messages)
      ? details[index + 1].request.messages
      : [];
    const assistantIndex = nextMessages.findIndex((message) => message?.role === "assistant" && Array.isArray(message.tool_calls));
    const toolCalls = assistantIndex >= 0 ? toolCallsFrom([nextMessages[assistantIndex]]) : [];

    const response = detail?.response || {};
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
      assistant: typeof response?.content === "string" || response?.content !== undefined
        ? { content: response.content ?? null, thinking: response.thinking ?? null, finishReason: response.finish_reason ?? null }
        : null,
      routing: detail?.routing || null,
      cacheHitRate: tokens.input > 0 ? tokens.cached / tokens.input : null,
      cumulativeTokens,
      cumulativeCostUsd: cumulativeCost,
      flags: [],
    });

    previousMessages = messages;
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

  const label = (firstUserMessage(first) || first?.request?.metadata?.sessionId || "session").slice(0, 96);

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
