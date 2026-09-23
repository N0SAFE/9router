/**
 * Build the payload the Sessions tab (and its SSE stream) renders for one
 * session: turns with metrics/flags, chat deltas, spikes, budget progress and
 * the monitored flag. Explicit sessions come from requestDetails.sessionId;
 * implicit ones are re-derived from the recent details ring.
 */

import { getAdapter } from "@/lib/db/driver.js";
import { getDetailsBySession, getRecentDetailRows } from "@/lib/db/index.js";
import { getSettings } from "@/lib/localDb";
import { getProviderConnections } from "@/lib/localDb";
import {
  budgetProgress,
  buildSessionTurns,
  detectSpikes,
  groupImplicitSessions,
  liveKeyForDetail,
  sanitizeLabel,
  summarizeSession,
} from "./sessions.js";
import { summarizeRouting } from "./routingEvents.js";
import { getSessionMonitor } from "./sessionMonitors.js";
import { findGeneratingSession } from "./liveSessions.js";

const LIVE_WINDOW_MS = 90 * 1000;

async function loadSessionDetails(sessionId) {
  if (!sessionId) return { details: [], kind: "unknown", liveKey: null };
  if (sessionId.startsWith("implicit:")) {
    const recent = await getRecentDetailRows(1000);
    const groups = groupImplicitSessions(recent);
    const match = groups.find((group) => group.id === sessionId);
    return { details: match?.details || [], kind: "implicit", liveKey: match?.liveKey || null };
  }
  if (sessionId.startsWith("live:")) {
    const liveKey = sessionId.slice("live:".length);
    const recent = await getRecentDetailRows(1000);
    const match = groupImplicitSessions(recent).find((group) => group.liveKey === liveKey);
    return { details: match?.details || [], kind: "implicit", liveKey };
  }
  const details = await getDetailsBySession(sessionId, 1000);
  return {
    details,
    kind: "explicit",
    liveKey: details.length > 0 ? liveKeyForDetail(details[0]) : null,
  };
}

function stripContent(turns) {
  return turns.map((turn) => ({
    ...turn,
    userMessages: (turn.userMessages || []).map((message) => ({ ...message, text: null, redacted: true })),
    toolMessages: (turn.toolMessages || []).map((message) => ({ ...message, text: null, redacted: true })),
    assistant: turn.assistant ? { ...turn.assistant, content: null, thinking: null, redacted: true } : null,
  }));
}

export async function buildSessionPayload(sessionId, options = {}) {
  const { includeContent = true } = options;
  const { details, kind, liveKey } = await loadSessionDetails(sessionId);
  const generatingEntry = findGeneratingSession({
    sessionId: kind === "explicit" ? sessionId : null,
    liveKey,
  });

  if (details.length === 0) {
    if (generatingEntry) {
      // Session is running but its first request has not finished yet.
      const monitor = await getSessionMonitor(sessionId);
      return {
        id: sessionId,
        kind,
        liveKey,
        missing: false,
        generating: true,
        live: true,
        summary: {
          label: generatingEntry.label || "running session",
          startedAt: generatingEntry.startedAt,
          lastAt: new Date(generatingEntry.lastEventAt).toISOString(),
          requests: generatingEntry.requests,
          failures: 0,
          tokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          providers: [],
          models: generatingEntry.model ? [generatingEntry.model] : [],
          apiKey: generatingEntry.apiKey || null,
          connectionId: null,
          kinds: [],
        },
        turns: [],
        routing: null,
        spikes: { flagged: [], costMedian: 0, tokenMedian: 0 },
        monitor,
        budget: null,
        contentMode: "full",
        generatedAt: new Date().toISOString(),
      };
    }
    return { id: sessionId, kind, liveKey, missing: true, summary: null, turns: [], routing: null, spikes: { flagged: [] } };
  }

  const [settings, connections] = await Promise.all([
    getSettings().catch(() => ({})),
    getProviderConnections().catch(() => []),
  ]);
  const connectionNames = Object.fromEntries(
    (connections || []).map((connection) => [
      connection.id,
      connection.displayName || connection.name || connection.email || connection.id,
    ])
  );

  const contentMode = settings?.observabilityContentMode === "none" ? "none" : "full";
  let turns = buildSessionTurns(details);
  // The analytics stream carries numbers only; message text travels on the
  // content stream so the chat view can render it live.
  if (contentMode === "none" || includeContent === false) turns = stripContent(turns);

  turns = turns.map((turn) => ({
    ...turn,
    connectionName: turn.connectionId ? connectionNames[turn.connectionId] || null : null,
    routeSummary: (() => {
      const trace = turn.routing || {};
      const parts = [];
      if (trace.combo?.name) parts.push(`combo ${trace.combo.name}`);
      if (trace.selected?.name) parts.push(`account ${trace.selected.name}`);
      if (Array.isArray(trace.attempts) && trace.attempts.length > 0) parts.push(`${trace.attempts.length} attempt(s)`);
      return parts.length > 0 ? parts.join(" · ") : null;
    })(),
  }));

  const spikes = detectSpikes(turns, options.spikeOptions || {});
  const summary = summarizeSession(details);
  const monitor = await getSessionMonitor(sessionId);
  const budget = monitor
    ? budgetProgress(summary, { costUsd: monitor.budgetUsd, tokens: monitor.budgetTokens })
    : null;
  const lastAt = summary.lastAt ? new Date(summary.lastAt).getTime() : 0;

  return {
    id: sessionId,
    kind,
    liveKey,
    missing: false,
    summary,
    turns,
    routing: summarizeRouting(turns),
    spikes,
    monitor,
    budget,
    contentMode,
    generating: Boolean(generatingEntry),
    live: (lastAt > 0 && Date.now() - lastAt < LIVE_WINDOW_MS) || Boolean(generatingEntry),
    generatedAt: new Date().toISOString(),
  };
}

/** List explicit sessions (sessionId column) with aggregated totals. */
export async function listExplicitSessions(limit = 200) {
  const db = await getAdapter();
  const capped = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const rows = db.all(
    `SELECT sessionId,
            COUNT(*) AS requests,
            MIN(timestamp) AS startedAt,
            MAX(timestamp) AS lastAt,
            MAX(provider) AS provider,
            MAX(model) AS model,
            SUM(COALESCE(json_extract(data, '$.cost'), 0)) AS costUsd,
            SUM(
              COALESCE(json_extract(data, '$.tokens.prompt_tokens'), 0) +
              COALESCE(json_extract(data, '$.tokens.completion_tokens'), 0) +
              COALESCE(json_extract(data, '$.tokens.reasoning_tokens'), 0)
            ) AS tokens,
            SUM(CASE WHEN status IS NOT NULL AND status NOT IN ('ok', 'success') THEN 1 ELSE 0 END) AS failures
     FROM requestDetails
     WHERE sessionId IS NOT NULL
     GROUP BY sessionId
     ORDER BY lastAt DESC
     LIMIT ?`,
    [capped]
  );

  // Labels: first user message of each session (one row per session).
  const labels = {};
  try {
    const labelRows = db.all(
      `SELECT d.sessionId AS sessionId, d.data AS data
       FROM requestDetails d
       JOIN (
         SELECT sessionId AS sid, MIN(timestamp) AS t
         FROM requestDetails
         WHERE sessionId IS NOT NULL
         GROUP BY sessionId
       ) m ON d.sessionId = m.sid AND d.timestamp = m.t`
    );
    for (const row of labelRows) {
      try {
        const detail = JSON.parse(row.data);
        const messages = Array.isArray(detail?.request?.messages) ? detail.request.messages : [];
        const user = messages.find((message) => message?.role === "user");
        const text = typeof user?.content === "string"
          ? user.content
          : Array.isArray(user?.content)
            ? user.content.map((part) => part?.text || "").join(" ")
            : "";
        // Noise-only messages must not become labels: skip and let the model fallback win.
        const label = text ? sanitizeLabel(text) : null;
        if (label) labels[row.sessionId] = label;
      } catch {
        // ignore malformed rows
      }
    }
  } catch {
    // labels are best-effort
  }

  return rows.map((row) => ({
    id: row.sessionId,
    kind: "explicit",
    label: labels[row.sessionId] || row.sessionId.slice(0, 24),
    provider: row.provider || null,
    model: row.model || null,
    requests: row.requests || 0,
    failures: row.failures || 0,
    tokens: row.tokens || 0,
    costUsd: row.costUsd || 0,
    startedAt: row.startedAt || null,
    lastAt: row.lastAt || null,
    live: row.lastAt ? Date.now() - new Date(row.lastAt).getTime() < LIVE_WINDOW_MS : false,
  }));
}

/** List implicit sessions from the recent details ring. */
export async function listImplicitSessions(limit = 100) {
  const recent = await getRecentDetailRows(800);
  const groups = groupImplicitSessions(recent).slice(0, limit);
  return groups.map((group) => {
    const summary = summarizeSession(group.details);
    return {
      id: group.id,
      kind: "implicit",
      liveKey: group.liveKey || null,
      label: summary.label,
      provider: summary.providers[0] || null,
      model: summary.models[0] || null,
      requests: summary.requests,
      failures: summary.failures,
      tokens: summary.tokens,
      costUsd: summary.costUsd,
      startedAt: summary.startedAt,
      lastAt: summary.lastAt,
      live: summary.lastAt ? Date.now() - new Date(summary.lastAt).getTime() < LIVE_WINDOW_MS : false,
    };
  });
}
