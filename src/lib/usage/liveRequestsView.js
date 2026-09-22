/**
 * Live requests view payload: in-flight requests with their routing events,
 * plus recently persisted requests so the view stays useful between requests.
 */

import { getRecentDetailRows } from "@/lib/db/index.js";
import { extractMessageText } from "@/lib/keys/policy.js";
import { listLiveRequests } from "./liveRouting.js";

const PERSISTED_WINDOW_MS = 30 * 60 * 1000;
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

function isSuccessStatus(status) {
  return !status || status === "ok" || status === "success";
}

export function detectContextProblem(text) {
  return CONTEXT_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}

/** Turn a persisted routing trace back into event rows for the trace view. */
export function eventsFromTrace(detail) {
  const trace = detail?.routing || {};
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
  if (isSuccessStatus(detail?.status)) {
    events.push({ type: "complete", message: "completed" });
  } else {
    events.push({ type: "error", message: String(detail?.status || "error") });
  }
  return events;
}

export async function buildLiveRequestsPayload() {
  const live = listLiveRequests().map((entry) => ({ ...entry, persisted: false }));
  const liveIds = new Set(live.map((entry) => entry.id));

  const recent = await getRecentDetailRows(60).catch(() => []);
  const persisted = recent
    .filter((detail) => detail?.routing)
    .filter((detail) => {
      const at = detail?.timestamp ? new Date(detail.timestamp).getTime() : 0;
      return at > 0 && Date.now() - at <= PERSISTED_WINDOW_MS && !liveIds.has(detail.id);
    })
    .map((detail) => {
      const trace = detail.routing || {};
      const attempts = Array.isArray(trace.attempts) ? trace.attempts : [];
      const text = extractMessageText(detail?.request || {});
      const failed = !isSuccessStatus(detail.status);
      return {
        id: detail.id,
        persisted: true,
        sessionId: detail.sessionId || null,
        requestedModel: trace.requestedModel || detail.model || null,
        provider: detail.provider || trace.provider || null,
        model: detail.model || trace.model || null,
        label: (text || "").slice(0, 96) || null,
        combo: trace.combo?.name || null,
        status: failed ? "error" : "completed",
        error: failed ? String(detail.status || "error") : null,
        contextProblem: detectContextProblem(
          `${detail.status || ""} ${attempts.map((attempt) => attempt.error || "").join(" ")}`
        ),
        startedAt: detail.timestamp,
        startedAtMs: detail.timestamp ? new Date(detail.timestamp).getTime() : 0,
        durationMs: Number(detail.latency?.total) || null,
        tokens: detail.tokens || null,
        costUsd: Number(detail.cost) || 0,
        attempts,
        events: eventsFromTrace(detail),
      };
    });

  const requests = [...live, ...persisted]
    .sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0))
    .slice(0, 50);

  return {
    requests,
    counts: {
      total: requests.length,
      live: requests.filter((entry) => !entry.persisted).length,
      routing: requests.filter((entry) => entry.status === "routing" || entry.status === "fallback").length,
      streaming: requests.filter((entry) => entry.status === "streaming").length,
      errors: requests.filter((entry) => entry.status === "error").length,
      contextProblems: requests.filter((entry) => entry.contextProblem).length,
    },
    generatedAt: new Date().toISOString(),
  };
}
