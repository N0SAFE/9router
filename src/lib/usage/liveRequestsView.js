/**
 * Live requests view payload: in-flight requests with their routing events,
 * plus recently persisted requests so the view stays useful between requests.
 */

import { getRecentDetailRows } from "@/lib/db/index.js";
import { extractMessageText } from "@/lib/keys/policy.js";
import { detectContextProblem, eventsFromTrace, isSuccessStatus } from "./routingEvents.js";
import { listLiveRequests } from "./liveRouting.js";

const PERSISTED_WINDOW_MS = 30 * 60 * 1000;
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
      const latestAttempt = [...attempts].reverse().find((attempt) => attempt?.connectionId || attempt?.account);
      const selected = trace.selected || {};
      const connectionId = detail.connectionId || selected.connectionId || latestAttempt?.connectionId || null;
      const connectionName = detail.connectionName || selected.name || latestAttempt?.account || null;
      const text = extractMessageText(detail?.request || {});
      const failed = !isSuccessStatus(detail.status);
      return {
        id: detail.id,
        persisted: true,
        sessionId: detail.sessionId || null,
        requestedModel: trace.requestedModel || detail.model || null,
        provider: detail.provider || trace.provider || null,
        model: detail.model || trace.model || null,
        connectionId,
        connectionName,
        label: (text || "").slice(0, 96) || null,
        combo: trace.combo?.name || null,
        status: failed ? "error" : "completed",
        error: failed ? String(detail.status || "error") : null,
        contextProblem: detectContextProblem(
          `${detail.status || ""} ${attempts.map((attempt) => attempt.error || "").join(" ")}`
        ),
        startedAt: detail.timestamp,
        startedAtMs: detail.timestamp ? new Date(detail.timestamp).getTime() : 0,
        completedAt: detail.timestamp,
        completedAtMs: detail.timestamp ? new Date(detail.timestamp).getTime() : 0,
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
