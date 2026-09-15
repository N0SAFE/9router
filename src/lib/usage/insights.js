/**
 * Token-usage insight engine.
 *
 * Turns stored request details into (a) an overview, (b) aggregated waste
 * patterns with plain-language explanations and fixes, and (c) per-request
 * flags. Pure functions only — pricing is injected via `costEstimator` so the
 * module is trivially unit-testable.
 *
 * The heuristics are intentionally boring and explainable: every pattern maps to
 * one concrete lever (Headroom pipeline, RTK, prompt caching, effort routing,
 * tool-schema compaction, history compaction, provider fallback).
 */

export const INSIGHT_THRESHOLDS = {
  oversizedContextTokens: 100_000,
  largeContextTokens: 20_000,
  lowCacheRatio: 0.15,
  reasoningShare: 0.3,
  reasoningMinTokens: 1_000,
  verboseOutputTokens: 8_000,
  xlargeOutputTokens: 20_000,
  expensiveRequestCost: 0.05,
  manyTools: 20,
  longHistory: 50,
  truncatedRequestBytes: 20_000,
  offenders: 8,
};

export const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };

const PATTERN_META = {
  oversized_context: {
    title: "Oversized context",
    severity: "high",
    explanation: "A single request carried a very large prompt. Full file reads, logs and long histories are billed on every turn they stay in context.",
    tip: "Turn on the Headroom pipeline (Token Saver) so live tool output is compressed, and enable RTK. Prefer targeted reads over whole-file dumps.",
  },
  no_cache_reuse: {
    title: "No prompt-cache reuse",
    severity: "medium",
    explanation: "A large prompt was billed with zero cached tokens. The provider re-processed the identical prefix instead of reading it from cache.",
    tip: "Keep the system prompt and tool list byte-stable and pass a stable session id so the prefix is cacheable. Headroom's cache mode and CacheAligner help.",
  },
  low_cache_ratio: {
    title: "Low cache hit rate",
    severity: "low",
    explanation: "Most of a large prompt missed the provider's prompt cache, so input was billed at the full rate.",
    tip: "Avoid reordering tools or mutating early messages between turns; keep volatile content at the end of the conversation.",
  },
  reasoning_heavy: {
    title: "Heavy reasoning output",
    severity: "medium",
    explanation: "A large share of the output was internal reasoning tokens, which are billed like output tokens.",
    tip: "Lower the reasoning effort for routine turns (Headroom output shaping / effort routing) and reserve high effort for hard steps.",
  },
  verbose_output: {
    title: "Verbose output",
    severity: "medium",
    explanation: "The model produced far more output than the input justified — replays, preambles and restated context.",
    tip: "Enable Headroom output shaping for terse steering and cap max output tokens per request.",
  },
  xlarge_output: {
    title: "Very large generation",
    severity: "high",
    explanation: "A single response emitted a very large number of tokens, which is expensive on every provider.",
    tip: "Cap max output tokens and ask for diffs/patches instead of full file rewrites.",
  },
  expensive_model: {
    title: "Expensive model for routine work",
    severity: "medium",
    explanation: "This request's estimated cost is high relative to typical traffic.",
    tip: "Add a cheaper model as a fallback/combo member or route small, tool-free turns to a lighter model.",
  },
  large_tool_schema: {
    title: "Large tool schemas",
    severity: "medium",
    explanation: "The full tool catalogue is serialized into every request, even when most tools are unused.",
    tip: "Dedupe tools and let Headroom defer schemas behind tool search; remove unused MCP tools from the session.",
  },
  long_history: {
    title: "Long conversation history",
    severity: "low",
    explanation: "The request carried a long message history that grows the prompt on every turn.",
    tip: "Compact older turns, summarise resolved threads, or let Headroom's live-zone compression fold superseded reads.",
  },
  retry_waste: {
    title: "Failed request",
    severity: "high",
    explanation: "The request errored (rate limit, provider error, invalid request). Retries and fallbacks can spend tokens with no useful output.",
    tip: "Check provider cooldowns and account health; let the account pool rotate instead of retrying the same credential.",
  },
};

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function getInputTokens(tokens = {}) {
  const prompt = num(tokens.prompt_tokens) || num(tokens.input_tokens);
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

export function getCachedTokens(tokens = {}) {
  return num(tokens.cached_tokens) || num(tokens.cache_read_input_tokens);
}

export function getCacheCreationTokens(tokens = {}) {
  return num(tokens.cache_creation_input_tokens);
}

export function getOutputTokens(tokens = {}) {
  return num(tokens.completion_tokens) || num(tokens.output_tokens);
}

export function getReasoningTokens(tokens = {}) {
  return num(tokens.reasoning_tokens);
}

// JSON byte length / 4 is the usual rough token estimate for schemas/history.
function approxTokensFromBytes(bytes) {
  return Math.round(num(bytes) / 4);
}

function toolSchemaTokens(request) {
  if (!request || typeof request !== "object") return 0;
  if (Array.isArray(request.tools)) {
    try {
      return approxTokensFromBytes(JSON.stringify(request.tools).length);
    } catch {
      return 0;
    }
  }
  // Truncated request: the original size is the only signal we kept.
  if (request._truncated && num(request._originalSize) > 0) {
    return approxTokensFromBytes(request._originalSize);
  }
  return 0;
}

/**
 * Per-request flags. Each flag: { id, wastedTokens, wastedUsd? }.
 * `costEstimator(row)` returns the request's cost in USD (or 0).
 */
export function analyzeRequest(row, { costEstimator } = {}) {
  const tokens = row?.tokens || {};
  const input = getInputTokens(tokens);
  const cached = getCachedTokens(tokens);
  const output = getOutputTokens(tokens);
  const reasoning = getReasoningTokens(tokens);
  const total = input + output;
  const request = row?.request;
  const messages = Array.isArray(request?.messages) ? request.messages.length : 0;
  const tools = Array.isArray(request?.tools) ? request.tools.length : 0;
  const cost = typeof costEstimator === "function" ? num(costEstimator(row)) : 0;

  const flags = [];
  const T = INSIGHT_THRESHOLDS;

  // Failed request: the whole attempt is wasted work.
  if (row?.status && row.status !== "success" && total + reasoning > 0) {
    flags.push({ id: "retry_waste", wastedTokens: total + reasoning });
  }

  if (input >= T.oversizedContextTokens || (request?._truncated && num(request._originalSize) >= T.truncatedRequestBytes && input >= T.largeContextTokens)) {
    flags.push({ id: "oversized_context", wastedTokens: Math.round((input - T.largeContextTokens) * 0.4) });
  }

  if (input >= T.largeContextTokens && cached === 0) {
    flags.push({ id: "no_cache_reuse", wastedTokens: Math.round(input * 0.5) });
  } else if (input >= T.largeContextTokens) {
    const ratio = cached / input;
    if (ratio < T.lowCacheRatio) {
      flags.push({ id: "low_cache_ratio", wastedTokens: Math.round(input * (T.lowCacheRatio - ratio) * 0.8) });
    }
  }

  if (reasoning >= T.reasoningMinTokens && output > 0 && reasoning / output >= T.reasoningShare) {
    flags.push({ id: "reasoning_heavy", wastedTokens: Math.round(reasoning * 0.5) });
  }

  if (output >= T.xlargeOutputTokens) {
    flags.push({ id: "xlarge_output", wastedTokens: Math.round((output - T.verboseOutputTokens) * 0.5) });
  } else if (output >= T.verboseOutputTokens && output > input) {
    flags.push({ id: "verbose_output", wastedTokens: Math.round((output - T.verboseOutputTokens) * 0.5) });
  }

  if (cost >= T.expensiveRequestCost) {
    flags.push({ id: "expensive_model", wastedTokens: 0, wastedUsd: Number((cost * 0.3).toFixed(6)) });
  }

  if (tools >= T.manyTools) {
    flags.push({ id: "large_tool_schema", wastedTokens: Math.round(toolSchemaTokens(request) * 0.5) });
  }

  if (messages >= T.longHistory) {
    flags.push({ id: "long_history", wastedTokens: Math.round(input * 0.2) });
  }

  // Cap total flagged tokens at what the request actually spent.
  const rawWasted = flags.reduce((sum, f) => sum + num(f.wastedTokens), 0);
  const wastedTokens = Math.min(rawWasted, Math.max(total + reasoning, 0));
  const scoreBase = total + reasoning;
  const wasteScore = scoreBase > 0 ? Math.min(100, Math.round((wastedTokens / scoreBase) * 100)) : 0;

  return {
    input,
    cached,
    output,
    reasoning,
    total,
    cost,
    flags,
    wastedTokens,
    wasteScore,
    toolCount: tools,
    messageCount: messages,
  };
}

/**
 * Analyze a batch of stored request details.
 * @param {Array<object>} rows
 * @param {{ costEstimator?: (row: object) => number }} [options]
 */
export function analyzeRequestDetails(rows = [], { costEstimator } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const patternMap = new Map();
  const offenders = [];

  const overview = {
    requests: list.length,
    successes: 0,
    failures: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    potentialSavingsTokens: 0,
    potentialSavingsUsd: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    cacheHitRate: 0,
  };

  let latencySum = 0;

  for (const row of list) {
    const a = analyzeRequest(row, { costEstimator });
    const isSuccess = !row.status || row.status === "success";
    if (isSuccess) overview.successes += 1;
    else overview.failures += 1;

    overview.inputTokens += a.input;
    overview.cachedTokens += a.cached;
    overview.outputTokens += a.output;
    overview.reasoningTokens += a.reasoning;
    overview.totalTokens += a.total;
    overview.totalCost += a.cost;
    overview.potentialSavingsTokens += a.wastedTokens;
    overview.potentialSavingsUsd += a.total > 0 ? (a.wastedTokens / a.total) * a.cost : 0;

    const latency = num(row?.latency?.total);
    latencySum += latency;
    if (latency > 0) {
      // Track a small reservoir of all latencies for p95. Kept simple: reuse an array.
      (overview.__latencies ||= []).push(latency);
    }

    for (const flag of a.flags) {
      const meta = PATTERN_META[flag.id] || { title: flag.id, severity: "low", explanation: "", tip: "" };
      const entry = patternMap.get(flag.id) || {
        id: flag.id,
        ...meta,
        occurrences: 0,
        wastedTokens: 0,
        wastedUsd: 0,
        examples: [],
      };
      entry.occurrences += 1;
      entry.wastedTokens += num(flag.wastedTokens);
      entry.wastedUsd += num(flag.wastedUsd);
      if (entry.examples.length < 3) {
        entry.examples.push({
          id: row.id || null,
          timestamp: row.timestamp || null,
          provider: row.provider || null,
          model: row.model || null,
        });
      }
      patternMap.set(flag.id, entry);
    }

    if (a.wastedTokens > 0) {
      offenders.push({
        id: row.id || null,
        timestamp: row.timestamp || null,
        provider: row.provider || null,
        model: row.model || null,
        status: row.status || "success",
        tokens: row.tokens || {},
        latency: row.latency || {},
        totalTokens: a.total,
        wastedTokens: a.wastedTokens,
        wasteScore: a.wasteScore,
        cost: a.cost,
        reasonIds: a.flags.map((f) => f.id),
      });
    }
  }

  const latencies = (overview.__latencies || []).slice().sort((a, b) => a - b);
  delete overview.__latencies;
  overview.avgLatencyMs = list.length > 0 ? Math.round(latencySum / list.length) : 0;
  overview.p95LatencyMs = latencies.length > 0
    ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
    : 0;
  overview.cacheHitRate = overview.inputTokens > 0 ? overview.cachedTokens / overview.inputTokens : 0;
  overview.potentialSavingsUsd = Number(overview.potentialSavingsUsd.toFixed(6));

  const patterns = [...patternMap.values()].sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0);
    if (bySeverity !== 0) return bySeverity;
    return b.wastedTokens - a.wastedTokens;
  });

  offenders.sort((a, b) => b.wastedTokens - a.wastedTokens);

  return {
    overview,
    patterns,
    offenders: offenders.slice(0, INSIGHT_THRESHOLDS.offenders),
  };
}

export { PATTERN_META };
