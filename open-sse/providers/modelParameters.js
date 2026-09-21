/**
 * Per-model request settings descriptor.
 *
 * Publishes, for every model, which request parameters it accepts and which
 * values are valid — reasoning/thinking levels, budget-token ranges, temperature
 * support, output ceilings, tools, streaming, and so on. Everything is derived
 * from the same sources the request pipeline uses (capabilities, thinking
 * levels, parameter-strip rules), so the listing can never drift from reality
 * and no client needs a hardcoded per-model table.
 *
 * Output shape (per parameter, only entries that are meaningful):
 *   "temperature":      { supported: false }
 *   "reasoning_effort": { supported: true, values: ["none","low",...], default: null }
 *   "thinking":         { supported: true, format: "claude-budget", canDisable: false,
 *                         budgetTokens: { min, max } | null }
 *   "max_tokens":       { supported: true, max: 384000 }
 */

import { getCapabilitiesForModel } from "./capabilities.js";
import { getThinkingLevels } from "./thinkingLevels.js";
import { getParamSupport } from "../translator/concerns/paramSupport.js";

// Canonical chat-completions parameters clients may send. `supported` is added
// per model; ranges are spec-level, not model-specific.
const CHAT_PARAMETERS = [
  { id: "temperature", type: "number", range: { min: 0, max: 2 } },
  { id: "top_p", type: "number", range: { min: 0, max: 1 } },
  { id: "top_k", type: "number" },
  { id: "presence_penalty", type: "number", range: { min: -2, max: 2 } },
  { id: "frequency_penalty", type: "number", range: { min: -2, max: 2 } },
  { id: "seed", type: "number" },
  { id: "stop", type: "array" },
  { id: "logprobs", type: "boolean" },
  { id: "top_logprobs", type: "number" },
  { id: "logit_bias", type: "object" },
  { id: "n", type: "number" },
  { id: "max_tokens", type: "number", alias: ["max_completion_tokens", "max_output_tokens"] },
  { id: "response_format", type: "object" },
  { id: "tools", type: "array" },
  { id: "tool_choice", type: "object" },
  { id: "parallel_tool_calls", type: "boolean" },
  { id: "stream", type: "boolean" },
];

/**
 * @param {string} provider provider id (or alias)
 * @param {string} model raw model id
 * @param {{ maxOutput?: number }} [overrides] effective limit from the listing
 * @returns {{ parameters: Record<string, object> }}
 */
export function getModelParameters(provider, model, overrides = {}) {
  const caps = getCapabilitiesForModel(provider, model);
  const support = getParamSupport(provider, model);
  const dropped = new Set(support.dropped);
  const parameters = {};

  for (const parameter of CHAT_PARAMETERS) {
    const entry = { supported: true };
    if (parameter.type) entry.type = parameter.type;
    if (parameter.range) entry.range = { ...parameter.range };
    if (parameter.alias) entry.alias = [...parameter.alias];
    if (dropped.has(parameter.id)) entry.supported = false;
    if ((parameter.id === "tools" || parameter.id === "tool_choice") && caps.tools === false) {
      entry.supported = false;
    }
    if (parameter.id === "max_tokens") {
      const ceiling = Number.isFinite(overrides.maxOutput) && overrides.maxOutput > 0
        ? overrides.maxOutput
        : caps.maxOutput;
      const cap = support.maxOutputCap;
      const effective = Number.isFinite(cap) && cap > 0 && Number.isFinite(ceiling)
        ? Math.min(ceiling, cap)
        : (Number.isFinite(ceiling) ? ceiling : cap);
      if (Number.isFinite(effective) && effective > 0) entry.max = effective;
    }
    parameters[parameter.id] = entry;
  }

  // Reasoning/thinking: the same level sets the UI picker and the translator use.
  if (caps.reasoning) {
    const levels = getThinkingLevels(provider, model);
    parameters.reasoning_effort = {
      supported: true,
      type: "enum",
      values: Array.isArray(levels) && levels.length > 0 ? [...levels] : null,
      default: null,
    };
    parameters.thinking = {
      supported: true,
      format: caps.thinkingFormat || null,
      canDisable: caps.thinkingCanDisable !== false,
      budgetTokens: caps.thinkingRange && typeof caps.thinkingRange === "object"
        ? { min: caps.thinkingRange.min ?? null, max: caps.thinkingRange.max ?? null }
        : null,
    };
    if (dropped.has("thinking")) parameters.thinking.supported = false;
    if (dropped.has("reasoning_effort")) parameters.reasoning_effort.supported = false;
  } else {
    parameters.reasoning_effort = { supported: false };
    parameters.thinking = { supported: false };
  }

  if (caps.vision === true) {
    parameters.image_input = { supported: true, type: "array" };
  }

  return { parameters };
}

/** Compact human summary for pickers/tooltips (e.g. "effort: low·medium·high · temp ✕"). */
export function describeModelParameters(provider, model, overrides = {}) {
  const { parameters } = getModelParameters(provider, model, overrides);
  const parts = [];
  const effort = parameters.reasoning_effort;
  if (effort?.supported) {
    parts.push(effort.values?.length ? `effort: ${effort.values.join("·")}` : "effort: on");
  }
  const budget = parameters.thinking?.budgetTokens;
  if (parameters.thinking?.supported && budget && (budget.min || budget.max)) {
    parts.push(`thinking budget: ${budget.min ?? "?"}–${budget.max ?? "?"}`);
  }
  if (parameters.temperature?.supported === false) parts.push("temp ✕");
  if (parameters.max_tokens?.max) parts.push(`max out ${parameters.max_tokens.max}`);
  return parts.join(" · ");
}
