/**
 * LLM fix-prompt builder for token-leak patterns.
 *
 * Produces a complete, copy-paste prompt: detection evidence (including raw
 * request/response payloads when available), the current 9Router configuration,
 * the exact setting keys the model is allowed to propose changes to, and the
 * required answer format. The prompt explicitly asks the model to first decide
 * whether the pattern is a genuine leak or a false positive.
 */

import { INSIGHT_THRESHOLDS } from "./insights.js";

// Which thresholds produced each pattern — embedded so the model can reason
// about borderline cases instead of trusting the flag blindly.
const PATTERN_THRESHOLD_KEYS = {
  oversized_context: ["oversizedContextTokens", "largeContextTokens", "truncatedRequestBytes"],
  no_cache_reuse: ["largeContextTokens", "lowCacheRatio"],
  low_cache_ratio: ["largeContextTokens", "lowCacheRatio"],
  reasoning_heavy: ["reasoningShare", "reasoningMinTokens"],
  verbose_output: ["verboseOutputTokens", "xlargeOutputTokens"],
  xlarge_output: ["xlargeOutputTokens", "verboseOutputTokens"],
  expensive_model: ["expensiveRequestCost"],
  large_tool_schema: ["manyTools"],
  long_history: ["longHistory"],
  retry_waste: [],
};

// Settings that can change token spend. Kept in sync with settingsRepo defaults.
const RELEVANT_SETTING_KEYS = [
  "rtkEnabled",
  "headroomEnabled",
  "headroomMode",
  "headroomCompressUserMessages",
  "headroomTimeoutMs",
  "cavemanEnabled",
  "cavemanLevel",
  "ponytailEnabled",
  "ponytailLevel",
  "pxpipeEnabled",
  "pxpipeMinChars",
  "pxpipeTimeoutMs",
  "observabilityMaxJsonSize",
  "observabilityContentMode",
  "outboundProxyEnabled",
];

const MAX_FIELD_CHARS = 6000;

function truncateText(value, maxChars = MAX_FIELD_CHARS) {
  if (value === undefined || value === null) return null;
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n… [truncated: ${text.length - maxChars} of ${text.length} characters omitted]`,
    truncated: true,
  };
}

function fence(label, value) {
  const truncated = truncateText(value);
  if (!truncated) return "";
  return `\n#### ${label}\n\`\`\`json\n${truncated.text}\n\`\`\`${truncated.truncated ? " (truncated)" : ""}\n`;
}

function fmtTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function fmtUsd(value) {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/**
 * @param {object} options
 * @param {object} options.pattern   - entry from analyzeRequestDetails().patterns
 * @param {object} [options.overview]- analyzeRequestDetails().overview
 * @param {Array}  [options.samples] - raw sample requests (payloads included)
 * @param {object} [options.settings]- current 9Router settings (already loaded)
 * @param {object} [options.window]  - { period, startDate, endDate, filters, sampled }
 */
export function buildFixPrompt({ pattern, overview = {}, samples = [], settings = {}, window: windowInfo = {} } = {}) {
  if (!pattern) {
    throw new Error("pattern is required");
  }

  const thresholdKeys = PATTERN_THRESHOLD_KEYS[pattern.id] || [];
  const thresholds = Object.fromEntries(
    thresholdKeys
      .filter((key) => key in INSIGHT_THRESHOLDS)
      .map((key) => [key, INSIGHT_THRESHOLDS[key]])
  );

  const configSnapshot = Object.fromEntries(
    RELEVANT_SETTING_KEYS
      .filter((key) => settings[key] !== undefined)
      .map((key) => [key, settings[key]])
  );

  const shareOfWindow = overview.totalTokens > 0
    ? `${((pattern.wastedTokens / overview.totalTokens) * 100).toFixed(1)}%`
    : "n/a";

  const lines = [];

  lines.push(`# Token-leak fix request: ${pattern.title}`);
  lines.push("");
  lines.push(
    "You are an expert in LLM token economics and in 9Router (a self-hosted OpenAI/Anthropic-compatible model gateway). " +
      "A usage analyzer scanned gateway traffic and flagged the pattern below. Your job is to determine whether it is a " +
      "**genuine token leak** and, if it is, to produce **exact, actionable fixes**."
  );
  lines.push("");

  lines.push("## Step 1 — Verdict (do this first)");
  lines.push("");
  lines.push(
    "1. State whether this is a real leak, a partial leak (some requests are legitimate), or a false positive.\n" +
      "2. Justify the verdict from the evidence below (token math, request shape, model type, workload).\n" +
      "3. If it is a false positive, say which evidence contradicts the flag and **stop** — do not invent fixes.\n" +
      "4. If it is real, continue to the fix plan."
  );
  lines.push("");

  lines.push("## Step 2 — Required answer format");
  lines.push("");
  lines.push(
    [
      "- **Verdict**: real / partial / false positive (one line).",
      "- **Root cause**: what concretely causes the avoidable spend (reference the samples).",
      "- **Fix plan**: ordered by impact. For every fix give: the exact 9Router setting key **and** the proposed value, " +
        "or the exact client-side change (e.g. tool output handling, output cap, prompt stability). Only propose changes " +
        "using the levers listed later in this prompt; if something requires a lever that is not listed, say so explicitly " +
        "instead of inventing a setting.",
      "- **Expected saving**: estimated tokens/requests affected and monthly saving if the fix is applied.",
      "- **Verification**: which numbers in the 9Router Usage page (Tokens, Cache hit, Wasted tokens, p95) should move, " +
        "and after how many requests the result is meaningful.",
      "- **Risks**: what could regress (e.g. compressed context hurting answer quality) and how to detect it.",
    ].join("\n")
  );
  lines.push("");

  lines.push("## Detected pattern");
  lines.push("");
  lines.push(`- id: \`${pattern.id}\``);
  lines.push(`- severity: ${pattern.severity}`);
  lines.push(`- title: ${pattern.title}`);
  lines.push(`- occurrences: ${pattern.occurrences} request(s)`);
  lines.push(`- avoidable tokens: ~${fmtTokens(pattern.wastedTokens)} (${shareOfWindow} of the window's tokens)`);
  lines.push(`- avoidable spend: ~${fmtUsd(pattern.wastedUsd)}`);
  lines.push(`- analyzer explanation: ${pattern.explanation}`);
  lines.push(`- analyzer tip (generic; do not copy blindly): ${pattern.tip}`);
  if (Object.keys(thresholds).length > 0) {
    lines.push(`- trigger thresholds: ${JSON.stringify(thresholds)}`);
  }
  lines.push("");

  if (Array.isArray(pattern.dimensions)) {
    // Not expected; kept defensive.
  } else if (pattern.dimensions) {
    const section = (label, entries) =>
      entries && entries.length > 0
        ? `- ${label}: ${entries.map((entry) => `${entry.name} (${entry.count}×)`).join(", ")}`
        : null;
    const dimLines = [
      section("providers hit", pattern.dimensions.providers),
      section("models hit", pattern.dimensions.models),
      section("accounts hit", pattern.dimensions.accounts),
    ].filter(Boolean);
    if (dimLines.length > 0) {
      lines.push("### Affected dimensions");
      lines.push("");
      lines.push(...dimLines);
      lines.push("");
    }
  }

  lines.push("## Window & scope");
  lines.push("");
  lines.push(`- period: ${windowInfo.period || "n/a"}`);
  lines.push(`- range: ${windowInfo.startDate || "all time"} → ${windowInfo.endDate || "now"}`);
  lines.push(`- active filters: ${windowInfo.filters && Object.keys(windowInfo.filters).length > 0 ? JSON.stringify(windowInfo.filters) : "none"}`);
  lines.push(`- requests sampled by the analyzer: ${windowInfo.sampled ?? "n/a"}`);
  lines.push(`- window totals: ${fmtTokens(overview.totalTokens)} tokens in/fair, ${overview.requests || 0} requests, cache hit rate ${((overview.cacheHitRate || 0) * 100).toFixed(1)}%, estimated cost ${fmtUsd(overview.totalCost)}`);
  lines.push(`- window split: input ${fmtTokens(overview.inputTokens)}, cached ${fmtTokens(overview.cachedTokens)}, output ${fmtTokens(overview.outputTokens)}, reasoning ${fmtTokens(overview.reasoningTokens)}`);
  lines.push("");

  lines.push("## Current 9Router configuration (relevant keys)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(configSnapshot, null, 2));
  lines.push("```");
  lines.push("");

  lines.push("## Levers available in 9Router (exact keys)");
  lines.push("");
  lines.push(
    [
      "- `headroomEnabled` / `headroomMode` / `headroomCompressUserMessages` / `headroomTimeoutMs` — Headroom context compression. " +
        "`headroomMode: \"compress\"` compresses messages through `/v1/compress` before routing; `headroomMode: \"pipeline\"` routes the " +
        "upstream call through Headroom so messages, tools, system prompt and output can be shaped (requires `headroomEnabled`). " +
        "Headroom also has optional extras: code (tree-sitter AST compression of code responses) and kompress (prose/agentic traces).",
      "- `rtkEnabled` — Token Saver's tool-output compression (git/grep/ls/tree/log output, typically 60-90% fewer input tokens).",
      "- `cavemanEnabled` / `cavemanLevel` — terse-style system prompt that cuts output tokens; `ponytailEnabled` / `ponytailLevel` is the companion output style.",
      "- `pxpipeEnabled` / `pxpipeMinChars` / `pxpipeTimeoutMs` — prompt compression pipeline for large requests (skips requests below `pxpipeMinChars`).",
      "- Combos (Dashboard → Combos): fallback chains / capacity adapters to send routine turns to cheaper models.",
      "- Connection pools (Dashboard → Providers): multiple accounts per provider with rotation and cooldowns; helps rate-limit retries.",
      "- Request shape: cap `max_tokens`/output size at the client, ask for diffs instead of full rewrites, keep the cached prefix byte-stable, " +
        "and lower `reasoning_effort` for routine turns where the provider supports it.",
      "- Observability: `observabilityMaxJsonSize` (KB per payload) and `observabilityMaxRecords` control how much raw evidence is kept.",
    ].join("\n")
  );
  lines.push("");

  lines.push(`## Evidence — ${samples.length} raw sample request(s)`);
  lines.push("");
  if (samples.length === 0) {
    lines.push(
      "_No raw payload was available for this pattern in the current window (observability may be off, or payloads exceeded " +
        "`observabilityMaxJsonSize`). Reason from the aggregate numbers only and say so if the verdict is uncertain._"
    );
  } else {
    samples.forEach((sample, index) => {
      lines.push(`### Sample ${index + 1}`);
      lines.push("");
      lines.push(`- id: \`${sample.id || "n/a"}\``);
      lines.push(`- timestamp: ${sample.timestamp || "n/a"}`);
      lines.push(`- provider / model: ${sample.provider || "?"} / ${sample.model || "?"}`);
      lines.push(`- account: ${sample.account || sample.connectionName || sample.connectionId || "n/a"}`);
      lines.push(`- status: ${sample.status || "success"}`);
      lines.push(
        `- tokens: input ${sample.tokens?.prompt_tokens ?? sample.tokens?.input_tokens ?? 0}, ` +
          `cached ${sample.tokens?.cached_tokens ?? sample.tokens?.cache_read_input_tokens ?? 0}, ` +
          `cache-write ${sample.tokens?.cache_creation_input_tokens ?? 0}, ` +
          `output ${sample.tokens?.completion_tokens ?? sample.tokens?.output_tokens ?? 0}, ` +
          `reasoning ${sample.tokens?.reasoning_tokens ?? 0}`
      );
      lines.push(`- latency (ms): ${JSON.stringify(sample.latency || {})}`);
      lines.push(`- estimated cost: ${fmtUsd(sample.cost)}`);
      if (Array.isArray(sample.flags) && sample.flags.length > 0) {
        lines.push(`- analyzer flags: ${sample.flags.map((flag) => `${flag.id}(~${fmtTokens(flag.wastedTokens)} tok)`).join(", ")}`);
      }
      if (sample.routingSummary) lines.push(`- routing summary: ${sample.routingSummary}`);
      lines.push("");
      lines.push(fence("Request payload (request)", sample.request));
      lines.push(fence("Provider request (what the provider received)", sample.providerRequest));
      lines.push(fence("Provider response (raw)", sample.providerResponse));
      lines.push(fence("Response returned to the client", sample.response));
      lines.push(fence("Routing trace", sample.routing));
      lines.push(fence("pxpipe stats", sample.pxpipe));
    });
  }

  lines.push("## Final reminder");
  lines.push("");
  lines.push(
    "Base every claim on the evidence above. If the samples do not contain enough information to be sure, say exactly " +
      "what to enable or collect next (for example `observabilityMaxJsonSize` / `observabilityMaxRecords`) instead of guessing. " +
      "Do not recommend disabling safety, and do not propose changes to keys that are not listed as levers."
  );

  return lines.filter((line) => line !== null && line !== undefined).join("\n");
}
