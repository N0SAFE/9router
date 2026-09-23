/**
 * Routing trace helpers shared by the server payloads and the dashboard UI.
 * Pure functions only: the Sessions tab imports this from the client bundle.
 */

const CONTEXT_PATTERNS = [
  /context[ _-]?length/i,
  /maximum context/i,
  /context window/i,
  /too many tokens/i,
  /token limit/i,
  /prompt is too long/i,
  /input length/i,
  /reduce the length/i,
];

export function isSuccessStatus(status) {
  return !status || status === "ok" || status === "success";
}

export function detectContextProblem(text) {
  return CONTEXT_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}

/**
 * Turn a routing trace (persisted detail or turn) into ordered event rows.
 * Accepts anything carrying `routing` + `status`.
 */
export function eventsFromTrace(source) {
  const trace = source?.routing || {};
  const events = [];
  if (trace.combo) {
    events.push({ type: "combo", message: `combo “${trace.combo.name}” (${trace.combo.strategy || "fallback"})` });
    for (const model of trace.combo.models || []) {
      events.push({
        type: "combo-model",
        model: model.model,
        status: model.status,
        error: model.error || null,
        message: `${model.model} · ${model.status}${model.error ? ` — ${model.error}` : ""}`,
      });
    }
  }
  if (trace.provider || trace.model) {
    events.push({ type: "model", message: `model ${trace.provider || "?"}/${trace.model || "?"}` });
  }
  if (trace.pool) {
    events.push({
      type: "pool",
      message: `pool ${trace.pool.provider || "?"} · ${trace.pool.strategy || "default"}${trace.pool.total != null ? ` · ${trace.pool.available ?? "?"}/${trace.pool.total} available` : ""}`,
    });
  }
  if (trace.selected) {
    events.push({ type: "account", message: `account ${trace.selected.name || trace.selected.connectionId || "?"}` });
  }
  for (const attempt of trace.attempts || []) {
    events.push({
      type: "attempt",
      status: attempt.status,
      error: attempt.error || null,
      action: attempt.action || null,
      message: `attempt ${attempt.name || attempt.connectionId || "?"} · ${attempt.status ?? "?"}${attempt.error ? ` — ${attempt.error}` : ""}${attempt.action ? ` → ${attempt.action}` : ""}`,
    });
  }
  if (isSuccessStatus(source?.status)) {
    events.push({ type: "complete", message: "completed" });
  } else {
    events.push({ type: "error", message: String(source?.status || "error") });
  }
  return events;
}

/** Attempts that forced a redirect (fallback), excluding permanent failures. */
export function fallbackCount(trace) {
  const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
  return attempts.filter((attempt) => attempt?.action && attempt.action !== "non-fallback").length;
}

/** Context/limit problem for one turn (status + attempt errors). */
export function turnContextProblem(turn) {
  const trace = turn?.routing || {};
  const attempts = Array.isArray(trace.attempts) ? trace.attempts : [];
  return detectContextProblem(`${turn?.status || ""} ${attempts.map((attempt) => attempt.error || "").join(" ")}`);
}

/**
 * Session-level routing rollup: which providers/accounts served the session,
 * which combos were involved, and how much retrying it took.
 */
export function summarizeRouting(turns = []) {
  const providers = new Map();
  const accounts = new Map();
  const combos = new Map();
  let attempts = 0;
  let fallbacks = 0;
  let errors = 0;
  let contextProblems = 0;

  for (const turn of turns) {
    const trace = turn?.routing || {};
    const provider = turn?.provider || trace.provider;
    if (provider) providers.set(provider, (providers.get(provider) || 0) + 1);

    const account = trace.selected?.name || trace.selected?.connectionId || turn?.connectionName;
    if (account) accounts.set(account, (accounts.get(account) || 0) + 1);

    if (trace.combo?.name) combos.set(trace.combo.name, (combos.get(trace.combo.name) || 0) + 1);

    const list = Array.isArray(trace.attempts) ? trace.attempts : [];
    attempts += list.length;
    fallbacks += fallbackCount(trace);
    if (!isSuccessStatus(turn?.status)) errors += 1;
    if (turnContextProblem(turn)) contextProblems += 1;
  }

  const toRows = (map) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

  return {
    providers: toRows(providers),
    accounts: toRows(accounts),
    combos: toRows(combos),
    attempts,
    fallbacks,
    errors,
    contextProblems,
  };
}

/**
 * Why a turn was expensive or slow: cache misses, retries, reasoning share,
 * oversized prompts, slow prefill/generation, spikes and hard failures.
 */
export function turnDiagnostics(turn) {
  const notes = [];
  if (!turn) return notes;
  const tokens = turn.tokens || {};
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const cached = Number(tokens.cached) || 0;
  const reasoning = Number(tokens.reasoning) || 0;
  const cacheRate = input > 0 ? cached / input : null;
  const failed = !isSuccessStatus(turn.status);
  const fallbacks = fallbackCount(turn.routing);
  const context = turnContextProblem(turn);

  if (context) notes.push({ level: "error", icon: "report", text: "Context/limit error — the prompt exceeded the model window." });
  if (failed) notes.push({ level: "error", icon: "error", text: `Request failed (${turn.status}).` });
  if (fallbacks > 0) {
    notes.push({
      level: "warning",
      icon: "restart_alt",
      text: `${fallbacks} fallback(s) before this reply — earlier attempts may still be billed.`,
    });
  }
  if (cacheRate !== null && input >= 2000 && cacheRate === 0) {
    notes.push({
      level: "warning",
      icon: "cached",
      text: `Cache miss — all ${input.toLocaleString()} input tokens billed at full price.`,
    });
  } else if (cacheRate !== null && input >= 5000 && cacheRate < 0.3) {
    notes.push({
      level: "info",
      icon: "cached",
      text: `Low cache reuse (${Math.round(cacheRate * 100)}%) — most of the prompt was re-sent.`,
    });
  }
  if (reasoning > 0 && output + reasoning > 0 && reasoning / (output + reasoning) > 0.5) {
    notes.push({
      level: "info",
      icon: "psychology",
      text: `Reasoning is ${Math.round((reasoning / (output + reasoning)) * 100)}% of the output tokens (billed as output).`,
    });
  }
  if (input >= 50000) {
    notes.push({ level: "info", icon: "data_usage", text: `Large prompt (${input.toLocaleString()} tokens) — check history growth.` });
  }
  if (turn.ttft && turn.ttft > 15000) {
    notes.push({ level: "info", icon: "timer", text: `Slow prefill — ${(turn.ttft / 1000).toFixed(1)}s before the first token.` });
  }
  if (turn.outputSpeed && turn.outputSpeed < 5 && output > 50) {
    notes.push({ level: "info", icon: "speed", text: `Slow generation — ${turn.outputSpeed.toFixed(1)} tok/s.` });
  }
  for (const flag of turn.flags || []) {
    notes.push({ level: "warning", icon: "local_fire_department", text: flag.message });
  }
  if (!turn.assistant?.content && !failed) {
    notes.push({ level: "info", icon: "info", text: "Empty response content." });
  }
  return notes;
}

/** Best-effort "this tool result is an error" heuristic for the chat cards. */
export function looksLikeToolError(text) {
  return typeof text === "string" && /(^|\b)(error|failed|exception|denied|timeout|not found)(\b|:)/i.test(text.slice(0, 400));
}

/**
 * Pair tool calls with their results. Results attached by the session builder
 * win; the message list is the fallback for older records.
 */
export function pairToolResults(toolCalls = [], toolMessages = []) {
  const results = [...(toolMessages || [])];
  return (toolCalls || []).map((call, index) => {
    const fallback = results[index]?.text || null;
    const result = call?.result ?? fallback;
    return {
      ...call,
      result,
      resultRole: results[index]?.role || null,
      resultIsError: call?.resultIsError ?? (fallback ? looksLikeToolError(fallback) : false),
    };
  });
}
