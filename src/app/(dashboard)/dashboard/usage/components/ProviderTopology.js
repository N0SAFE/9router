"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import {
  ReactFlow,
  Handle,
  Position,
  Controls,
  BaseEdge,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { fmtCompact, fmtTime } from "./format";

// Kame + electric particles along active edges. Counts/speed scale with the
// number of active connections (or in-flight requests) the edge carries.
const KAME_PARTICLE_COUNT = 6;
const SPARK_COUNT = 5;
const MAX_FLOW_BOOST = 3;
const FAILURE_BLINK_MS = 12_000;

const MODES = [
  { value: "providers", label: "Providers" },
  { value: "pools", label: "Pools" },
  { value: "combos", label: "Combos" },
];

const FIT_VIEW_OPTIONS = { padding: 0.2, duration: 200 };

function getProviderConfig(providerId) {
  const id = resolveProviderId(providerId);
  return AI_PROVIDERS[id] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return getProviderIconSrc(resolveProviderId(providerId));
}

function providerOfModel(model) {
  if (typeof model !== "string" || !model.includes("/")) return "unknown";
  return model.slice(0, model.indexOf("/"));
}

function normalizeProviderId(value) {
  return resolveProviderId(String(value || "unknown")).toLowerCase();
}

function activeLiveRequests(liveRequests) {
  return (liveRequests || []).filter((entry) => (
    entry?.persisted === false
    && !entry.finishedAt
    && entry.status !== "completed"
    && entry.status !== "error"
  ));
}

function connectionIdentity(entry) {
  const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
  const latestAttempt = [...attempts].reverse().find((attempt) => attempt?.connectionId || attempt?.account);
  const connectionId = entry?.connectionId || latestAttempt?.connectionId || null;
  const connectionName = entry?.connectionName
    || entry?.selectedAccount
    || latestAttempt?.account
    || latestAttempt?.connectionName
    || (connectionId ? connectionId.slice(0, 8) : null);
  return { connectionId, connectionName };
}

function hasConnectionIdentity(connectionId, connectionName) {
  return Boolean(connectionId || (connectionName && connectionName !== "unassigned"));
}

/**
 * Count distinct live sessions, not just active account/model rows. The
 * fallback keeps the canvas useful during the short window before the live
 * registry has emitted its selected connection.
 */
function buildSessionTopology(liveRequests, activeRequests, metricsSince = 0) {
  const byProvider = new Map();
  const byConnection = new Map();
  const connectionRows = new Map();
  const liveRows = new Map();
  const metricsByProvider = new Map();
  const failuresByProvider = new Map();
  const failuresByConnection = new Map();
  const active = activeLiveRequests(liveRequests);
  const activeIds = new Set(active.map((entry) => entry.id));
  const seenLiveIds = new Set();
  const now = Date.now();

  const connectionKey = (provider, connectionId, connectionName) => (
    `${provider}|${connectionId || connectionNameKey(connectionName) || "unassigned"}`
  );

  const getLiveRow = (provider, connectionId, connectionName) => {
    if (!hasConnectionIdentity(connectionId, connectionName)) return null;
    const key = connectionKey(provider, connectionId, connectionName);
    let row = liveRows.get(key);
    if (!row) {
      row = {
        provider,
        connectionId: connectionId || null,
        connectionName: connectionName || (connectionId ? String(connectionId).slice(0, 8) : "connection"),
        liveRequests: 0,
        liveTokens: 0,
        failureAt: 0,
        failureKind: null,
        failureMessage: null,
      };
      liveRows.set(key, row);
    }
    if (!row.connectionId && connectionId) row.connectionId = connectionId;
    if (row.connectionName === "unassigned" && connectionName) row.connectionName = connectionName;
    return row;
  };

  const updateFailure = (provider, connectionId, connectionName, failure) => {
    if (!provider || !failure.kind) return;
    const at = eventTime(failure.at);
    if (!at || now - at > FAILURE_BLINK_MS || at - now > 5_000) return;
    const row = getLiveRow(provider, connectionId, connectionName);
    if (row && (!row.failureAt || at >= row.failureAt)) {
      row.failureAt = at;
      row.failureKind = failure.kind;
      row.failureMessage = failure.message || null;
    }
    const currentProviderFailure = failuresByProvider.get(provider);
    if (!currentProviderFailure || at >= currentProviderFailure.at) {
      failuresByProvider.set(provider, { ...failure, at });
    }
    if (hasConnectionIdentity(connectionId, connectionName)) {
      const key = connectionKey(provider, connectionId, connectionName);
      const currentConnectionFailure = failuresByConnection.get(key);
      if (!currentConnectionFailure || at >= currentConnectionFailure.at) {
        failuresByConnection.set(key, { ...failure, at, provider, connectionId: connectionId || null, connectionName: connectionName || null });
      }
    }
  };

  for (const entry of active) {
    const provider = normalizeProviderId(entry.provider);
    const sessionKey = entry.sessionId || entry.liveKey || entry.id;
    const { connectionId, connectionName } = connectionIdentity(entry);
    if (!byProvider.has(provider)) byProvider.set(provider, new Set());
    byProvider.get(provider).add(sessionKey);
    if (!hasConnectionIdentity(connectionId, connectionName)) continue;
    const key = connectionKey(provider, connectionId, connectionName);
    if (!byConnection.has(key)) {
      byConnection.set(key, { provider, connectionId, connectionName, sessions: new Set() });
    }
    byConnection.get(key).sessions.add(sessionKey);
    if (!connectionRows.has(key)) {
      connectionRows.set(key, { provider, connectionId, connectionName, activeCount: 0, sessionCount: 0, sessions: new Set() });
    }
    const connectionRow = connectionRows.get(key);
    connectionRow.activeCount += 1;
    connectionRow.sessions.add(sessionKey);
  }

  for (const row of connectionRows.values()) {
    row.sessionCount = row.sessions.size;
    delete row.sessions;
  }

  // Live entries are also a lightweight real-time metrics overlay. Historical
  // routing data remains the baseline; only entries started after that snapshot
  // (or still in flight) are added, so persisted requests are not double-counted.
  for (const entry of liveRequests || []) {
    if (!entry || (entry.id && seenLiveIds.has(entry.id))) continue;
    if (entry.id) seenLiveIds.add(entry.id);
    const provider = normalizeProviderId(entry.provider);
    if (!entry.provider) continue;
    const isActive = activeIds.has(entry.id)
      || (entry.persisted === false && !entry.finishedAt && !["completed", "error"].includes(entry.status));
    const startedAt = Number(entry.startedAtMs) || eventTime(entry.startedAt);
    const completedAt = Number(entry.finishedAtMs) || Number(entry.completedAtMs) || eventTime(entry.finishedAt || entry.completedAt);
    const includeMetrics = isActive
      || !metricsSince
      || (startedAt > 0 && startedAt >= metricsSince)
      || (completedAt > 0 && completedAt >= metricsSince);
    const { connectionId, connectionName } = connectionIdentity(entry);

    if (includeMetrics) {
      const row = getLiveRow(provider, connectionId, connectionName);
      if (row) {
        row.liveRequests += 1;
        row.liveTokens += tokenTotal(entry.tokens);
      }
      const metrics = metricsByProvider.get(provider) || { requests: 0, tokens: 0 };
      metrics.requests += 1;
      metrics.tokens += tokenTotal(entry.tokens);
      metricsByProvider.set(provider, metrics);
    }

    const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    for (const attempt of attempts) {
      const attemptProvider = normalizeProviderId(attempt.provider || entry.provider);
      const kind = classifyFailure(attempt.status, attempt.error, attempt.action);
      updateFailure(attemptProvider, attempt.connectionId, attempt.account || attempt.connectionName, {
        kind,
        at: attempt.at,
        message: attempt.error || attempt.action || `HTTP ${attempt.status ?? "?"}`,
      });
    }
    for (const event of Array.isArray(entry.events) ? entry.events : []) {
      if (event.type !== "error") continue;
      const eventProvider = normalizeProviderId(event.provider || entry.provider);
      updateFailure(eventProvider, event.connectionId, event.connectionName || event.account, {
        kind: classifyFailure(event.status, event.error, event.action),
        at: event.at || event.atIso,
        message: event.error || event.message,
      });
    }
    if (entry.status === "error" && entry.error) {
      updateFailure(provider, connectionId, connectionName, {
        kind: classifyFailure(entry.status, entry.error),
        at: entry.finishedAtMs || entry.finishedAt,
        message: entry.error,
      });
    }
  }

  for (const request of activeRequests || []) {
    const provider = normalizeProviderId(request.provider);
    const connectionId = request.connectionId || null;
    const name = request.account || request.connectionName || (connectionId ? String(connectionId).slice(0, 8) : null);
    if (!hasConnectionIdentity(connectionId, name)) continue;
    const key = connectionKey(provider, connectionId, name);
    const existing = connectionRows.get(key)
      || [...connectionRows.values()].find((row) => (
        row.provider === provider
        && (row.connectionName === name || (connectionId && row.connectionId === connectionId))
      ));
    if (existing) {
      existing.activeCount += Number(request.count) > 0 ? Number(request.count) : 1;
      if (connectionId && !existing.connectionId) existing.connectionId = connectionId;
      if (name && !existing.connectionName) existing.connectionName = name;
      continue;
    }
    connectionRows.set(key, {
      provider,
      connectionId,
      connectionName: name,
      activeCount: Number(request.count) > 0 ? Number(request.count) : 1,
      sessionCount: 0,
    });
  }

  return {
    byProvider,
    byConnection,
    connectionRows,
    liveRows,
    metricsByProvider,
    failuresByProvider,
    failuresByConnection,
    totalSessions: [...byProvider.values()].reduce((sum, sessions) => sum + sessions.size, 0),
  };
}

function connectionNameKey(value) {
  return String(value || "").trim().toLowerCase();
}

function tokenTotal(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value || typeof value !== "object") return 0;
  const total = Number(value.total ?? value.totalTokens ?? value.total_tokens);
  if (Number.isFinite(total)) return total;
  const input = Number(
    value.input
    ?? value.prompt
    ?? value.promptTokens
    ?? value.prompt_tokens
    ?? value.input_tokens
    ?? 0
  );
  const output = Number(
    value.output
    ?? value.completion
    ?? value.completionTokens
    ?? value.completion_tokens
    ?? 0
  );
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

function isSuccessStatusValue(status) {
  if (status == null || status === "") return true;
  const numeric = Number(status);
  if (Number.isFinite(numeric)) return numeric >= 200 && numeric < 400;
  return ["ok", "success", "completed", "streaming"].includes(String(status).toLowerCase());
}

function classifyFailure(status, error, action) {
  if (isSuccessStatusValue(status) && !error) return null;
  const text = `${status || ""} ${error || ""} ${action || ""}`.toLowerCase();
  const numericStatus = Number(status);
  const warning = numericStatus === 429
    || numericStatus === 402
    || /rate.?limit|too many requests|resource.?exhausted|retry.?after|cooldown|overload|server overloaded|temporarily unavailable/.test(text)
    || /subscription|plan (has )?(ended|expired)|subscription.*(ended|expired)|billing|payment required|insufficient (credits|balance|funds)|credit balance/.test(text);
  return warning ? "warning" : "error";
}

function eventTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeProviderConnections(provider, routingProvider, topology, configuredConnections = []) {
  const providerKey = normalizeProviderId(provider.provider);
  const merged = new Map();
  const byName = new Map();
  const configuredRows = Array.isArray(configuredConnections) ? configuredConnections : [];

  const connectionIdOf = (connection) => connection?.connectionId || connection?.id || null;
  const connectionNameOf = (connection) => (
    connection?.name
    || connection?.connectionName
    || connection?.account
    || null
  );

  const registerName = (name, key) => {
    const normalizedName = connectionNameKey(name);
    if (normalizedName && !byName.has(normalizedName)) byName.set(normalizedName, key);
  };

  const findKey = (connection, preferName) => {
    const name = connectionNameKey(connectionNameOf(connection));
    if (preferName && name && byName.has(name)) return byName.get(name);
    const id = connectionIdOf(connection);
    if (id) return `id:${id}`;
    return name ? `name:${name}` : null;
  };

  const addHistoricalConnection = (connection) => {
    if (!connection) return;
    const id = connectionIdOf(connection);
    const name = connectionNameOf(connection);
    if (!hasConnectionIdentity(id, name)) return;
    // Configured connections retain distinct IDs. Routing rows with a stale or
    // alternate ID for the same account are reconciled by name below.
    const key = findKey(connection, false) || `name:${connectionNameKey(name)}`;
    if (!key || key === "name:") return;
    const current = merged.get(key) || {
      connectionId: id,
      name: name || (id ? String(id).slice(0, 8) : "connection"),
      provider: provider.provider,
      requests: 0,
      tokens: 0,
      failures: 0,
    };
    if (!current.connectionId && id) current.connectionId = id;
    if (!current.name && name) current.name = name;
    for (const field of ["requests", "tokens", "failures", "lastUsed", "testStatus", "cooldownUntil"]) {
      if (connection[field] !== undefined && connection[field] !== null) current[field] = connection[field];
    }
    merged.set(key, current);
    registerName(name, key);
  };

  for (const connection of configuredRows) addHistoricalConnection(connection);
  for (const connection of routingProvider?.connections || []) {
    const routingId = connectionIdOf(connection);
    const routingName = connectionNameOf(connection);
    if (!hasConnectionIdentity(routingId, routingName)) continue;
    const key = findKey(connection, true) || `id:${routingId}`;
    if (key === "id:null" || key === "id:undefined") {
      addHistoricalConnection(connection);
      continue;
    }
    const name = connectionNameOf(connection);
    const id = connectionIdOf(connection);
    const current = merged.get(key) || {
      connectionId: id,
      name: name || (id ? String(id).slice(0, 8) : "connection"),
      provider: provider.provider,
      requests: 0,
      tokens: 0,
      failures: 0,
    };
    if (!current.connectionId && id) current.connectionId = id;
    if (!current.name && name) current.name = name;
    for (const field of ["requests", "tokens", "failures", "lastUsed", "testStatus", "cooldownUntil"]) {
      if (connection[field] !== undefined && connection[field] !== null) current[field] = connection[field];
    }
    merged.set(key, current);
    registerName(name, key);
  }

  for (const row of topology.connectionRows.values()) {
    if (row.provider !== providerKey || !hasConnectionIdentity(row.connectionId, row.connectionName)) continue;
    const name = row.connectionName;
    const key = findKey({ connectionId: row.connectionId, connectionName: name }, true)
      || `id:${row.connectionId || connectionNameKey(name)}`;
    const current = merged.get(key) || {
      connectionId: row.connectionId,
      name: name || (row.connectionId ? String(row.connectionId).slice(0, 8) : "connection"),
      provider: provider.provider,
      requests: 0,
      tokens: 0,
      failures: 0,
    };
    current.activeCount = row.activeCount;
    current.sessionCount = row.sessionCount;
    if (!current.connectionId && row.connectionId) current.connectionId = row.connectionId;
    if (!current.name && name) current.name = name;
    merged.set(key, current);
    registerName(name, key);
  }

  for (const row of topology.liveRows?.values() || []) {
    if (row.provider !== providerKey || !hasConnectionIdentity(row.connectionId, row.connectionName)) continue;
    const key = findKey({ connectionId: row.connectionId, connectionName: row.connectionName }, true)
      || `id:${row.connectionId || connectionNameKey(row.connectionName)}`;
    const current = merged.get(key) || {
      connectionId: row.connectionId,
      name: row.connectionName,
      provider: provider.provider,
      requests: 0,
      tokens: 0,
      failures: 0,
    };
    current.liveRequests = (Number(current.liveRequests) || 0) + (Number(row.liveRequests) || 0);
    current.liveTokens = (Number(current.liveTokens) || 0) + (Number(row.liveTokens) || 0);
    if (row.failureAt && (!current.failureAt || row.failureAt >= current.failureAt)) {
      current.failureAt = row.failureAt;
      current.failureKind = row.failureKind;
      current.failureMessage = row.failureMessage;
    }
    merged.set(key, current);
    registerName(row.connectionName, key);
  }

  return [...merged.values()];
}

// Custom provider node - rectangle with image + name
function ProviderNode({ data }) {
  const {
    label,
    color,
    imageUrl,
    textIcon,
    active,
    connectionCount,
    requestCount,
    sessionCount,
    totalRequests,
    totalTokens,
    failureAt,
    failureKind,
    failureMessage,
    clickable,
    subtitle,
    role,
  } = data;
  const [imgError, setImgError] = useState(false);
  const isSource = role === "source";
  const failureColor = failureKind === "warning" ? "#f59e0b" : "#ef4444";
  const activityCount = Number(sessionCount) > 0 ? Number(sessionCount) : Number(requestCount) > 0 ? Number(requestCount) : 0;
  const metricsSubtitle = Number(totalRequests) > 0 || Number(totalTokens) > 0
    ? `${fmtCompact(totalRequests)} req · ${fmtCompact(totalTokens)} tok`
    : subtitle;
  // Glow grows with the number of connections this provider is using.
  const boost = Math.max(0, Math.min(MAX_FLOW_BOOST, (Number(connectionCount) || 0) - 1));
  return (
    <div
      className={`relative flex items-center gap-2.5 px-4 py-2.5 rounded-lg border-2 transition-all duration-300 bg-bg ${failureAt ? "topology-failure-blink" : ""}`}
      style={{
        borderColor: failureAt ? failureColor : active ? color : "var(--color-border)",
        boxShadow: failureAt
          ? `0 0 0 2px ${failureColor}33, 0 0 18px ${failureColor}55`
          : active ? `0 0 ${16 + boost * 8}px ${color}${boost > 0 ? "66" : "40"}` : "none",
        minWidth: "150px",
        cursor: clickable ? "pointer" : undefined,
      }}
      title={failureAt ? failureMessage || "Recent routing failure" : undefined}
    >
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />
      {isSource && (
        <>
          <Handle type="source" position={Position.Top} id="out-top" className="!bg-transparent !border-0 !w-0 !h-0" />
          <Handle type="source" position={Position.Bottom} id="out-bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
          <Handle type="source" position={Position.Left} id="out-left" className="!bg-transparent !border-0 !w-0 !h-0" />
          <Handle type="source" position={Position.Right} id="out-right" className="!bg-transparent !border-0 !w-0 !h-0" />
        </>
      )}

      {/* Provider icon */}
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}15` }}
      >
        {imageUrl && !imgError ? (
          <img
            src={imageUrl}
            alt={label}
            className="w-6 h-6 rounded-sm object-contain"
            loading="lazy"
            decoding="async"
            onError={() => {
              const m = imageUrl?.match(/^\/providers\/([^/]+)\.png$/i);
              if (m) markProviderIconMissing(m[1]);
              setImgError(true);
            }}
          />
        ) : (
          <span className="text-sm font-bold" style={{ color }}>{textIcon}</span>
        )}
      </div>

      <div className="min-w-0">
        <span
          className="block text-base font-medium truncate"
          style={{ color: failureAt ? failureColor : active ? color : "var(--color-text)" }}
        >
          {label}
        </span>
        {metricsSubtitle && <span className="block text-[11px] text-text-muted">{metricsSubtitle}</span>}
      </div>

      {failureAt && (
        <span
          key={`${failureAt}-${failureKind}`}
          className="topology-failure-pulse absolute -right-1 -top-1 size-2.5 rounded-full"
          style={{ backgroundColor: failureColor, boxShadow: `0 0 10px ${failureColor}` }}
          title={failureMessage || (failureKind === "warning" ? "Rate limit or subscription limit" : "Routing error")}
        />
      )}

      {/* Active indicator: sessions are the primary count; connections remain secondary. */}
      {active && activityCount > 0 && (
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
          style={{ backgroundColor: `${color}20`, color }}
          title={`${activityCount} active session${activityCount > 1 ? "s" : ""}${connectionCount > 0 ? ` · ${connectionCount} connection${connectionCount > 1 ? "s" : ""} in use` : ""}`}
        >
          {activityCount}
        </span>
      )}
      {active && (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
        </span>
      )}
    </div>
  );
}

ProviderNode.propTypes = { data: PropTypes.object.isRequired };

// One account inside a provider pool lane
function ConnectionNode({ data }) {
  const {
    label,
    requests,
    tokens,
    lastUsed,
    testStatus,
    cooling = false,
    active,
    activeCount,
    sessionCount,
    failureAt,
    failureKind,
    failureMessage,
    clickable,
  } = data;
  const ok = !cooling && testStatus !== "unavailable";
  const activityCount = Number(sessionCount) > 0 ? Number(sessionCount) : Number(activeCount) > 0 ? Number(activeCount) : 0;
  const failureColor = failureKind === "warning" ? "#f59e0b" : "#ef4444";
  return (
    <div
      className={`relative flex min-w-[180px] max-w-[220px] items-center gap-2 rounded-lg border bg-bg px-3 py-2 transition-colors ${failureAt ? "topology-failure-blink" : ""}`}
      style={{
        borderColor: failureAt ? failureColor : active ? "#22d3ee" : cooling ? "#f59e0b" : "var(--color-border)",
        boxShadow: failureAt ? `0 0 0 2px ${failureColor}33, 0 0 14px ${failureColor}55` : active ? "0 0 12px #22d3ee40" : "none",
        cursor: clickable ? "pointer" : undefined,
      }}
      title={failureAt ? failureMessage || "Recent routing failure" : undefined}
    >
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <span className={`block size-2 shrink-0 rounded-full ${failureAt ? (failureKind === "warning" ? "bg-warning" : "bg-danger") : active ? "bg-cyan-400" : cooling ? "bg-warning" : ok ? "bg-emerald-500" : "bg-danger"}`} />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-text-main">{label}</span>
        <span className="block text-[10px] text-text-muted">
          {fmtCompact(requests)} req
          {sessionCount > 0 ? ` · ${sessionCount} live session${sessionCount > 1 ? "s" : ""}` : ""}
          {tokens > 0 ? ` · ${fmtCompact(tokens)} tok` : ""}
          {lastUsed ? ` · ${fmtTime(lastUsed)}` : ""}
        </span>
      </div>
      {active && activityCount > 0 && (
        <span
          className="shrink-0 rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-cyan-600 dark:text-cyan-400"
          title={`${activityCount} active session${activityCount > 1 ? "s" : ""}`}
        >
          {activityCount}
        </span>
      )}
      {cooling && (
        <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">cooling</span>
      )}
      {failureAt && (
        <span
          key={`${failureAt}-${failureKind}`}
          className="topology-failure-pulse absolute -right-1 -top-1 size-2.5 rounded-full"
          style={{ backgroundColor: failureColor, boxShadow: `0 0 10px ${failureColor}` }}
          title={failureMessage || (failureKind === "warning" ? "Rate limit or subscription limit" : "Routing error")}
        />
      )}
    </div>
  );
}

ConnectionNode.propTypes = { data: PropTypes.object.isRequired };

// Combo (or capacity-adapter group) node
function ComboNode({ data }) {
  const { label, kind, strategy, attempts, ok, failed, clickable } = data;
  return (
    <div
      className="flex min-w-[170px] flex-col gap-1 rounded-lg border-2 border-brand-500/40 bg-bg px-3 py-2"
      style={{ cursor: clickable ? "pointer" : undefined }}
    >
      <Handle type="source" position={Position.Right} id="out-right" className="!bg-transparent !border-0 !w-0 !h-0" />
      <span className="truncate text-sm font-semibold text-text-main">{label}</span>
      <span className="text-[10px] uppercase tracking-wide text-text-muted">
        {kind === "capacity" ? "capacity adapter" : "combo"} · {strategy} · {attempts} run{attempts > 1 ? "s" : ""}
      </span>
      <span className="text-[10px] text-text-muted">
        <span className="text-emerald-600 dark:text-emerald-400">{ok} ok</span>
        {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
      </span>
    </div>
  );
}

ComboNode.propTypes = { data: PropTypes.object.isRequired };

// One model inside a combo
function ModelNode({ data }) {
  const { label, providerLabel, ok, failed, active, clickable } = data;
  return (
    <div
      className="flex min-w-[170px] max-w-[230px] items-center gap-2 rounded-lg border bg-bg px-3 py-2"
      style={{
        borderColor: active ? "#22d3ee" : "var(--color-border)",
        cursor: clickable ? "pointer" : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="out-right" className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-text-main">{label}</span>
        <span className="block truncate text-[10px] text-text-muted">{providerLabel}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-[10px]">
        {ok > 0 && <span className="rounded bg-emerald-500/10 px-1 text-emerald-600 dark:text-emerald-400">{ok}✓</span>}
        {failed > 0 && <span className="rounded bg-red-500/10 px-1 text-danger">{failed}✗</span>}
      </div>
    </div>
  );
}

ModelNode.propTypes = { data: PropTypes.object.isRequired };

// Center 9Router node — pulse/glow on card only (no expanding rings)
function RouterNode({ data }) {
  const powering = (data.activeCount || 0) > 0;
  return (
    <div
      className={`relative z-[1] flex items-center justify-center px-5 py-3 rounded-xl border-2 min-w-[130px] ${
        powering
          ? "topology-router-core border-yellow-300 bg-gradient-to-br from-primary/30 via-yellow-400/20 to-cyan-400/25"
          : "border-primary bg-primary/5 shadow-md"
      }`}
    >
      <Handle type="source" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <img
        src="/favicon.svg"
        alt="9Router"
        className={`w-6 h-6 mr-2 ${powering ? "topology-router-icon" : ""}`}
        loading="lazy"
        decoding="async"
      />
      <span className={`text-sm font-bold ${powering ? "topology-router-label text-yellow-300" : "text-primary"}`}>
        9Router
      </span>
      {data.activeCount > 0 && (
        <span
          className="ml-2 px-1.5 py-0.5 rounded-full bg-yellow-400 text-black text-xs font-bold tabular-nums topology-router-badge"
          title={`${data.activeCount} provider${data.activeCount > 1 ? "s" : ""} in use${data.activeRequests > 0 ? ` · ${data.activeRequests} in-flight request${data.activeRequests > 1 ? "s" : ""}` : ""}`}
        >
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

RouterNode.propTypes = { data: PropTypes.object.isRequired };

// Active: electric kame beam (multi-layer stroke + sparks). Idle/last/error: solid BaseEdge.
function TopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
  label,
  labelStyle,
  labelBgStyle,
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const active = !!data?.active;
  const stroke = style.stroke || "var(--color-border)";
  const filterId = `topo-electric-${id}`;
  // 1 connection → base flow; every extra connection up to MAX_FLOW_BOOST makes
  // the beam thicker, faster and denser.
  const intensity = Math.max(1, Number(data?.intensity) || 1);
  const boost = Math.min(MAX_FLOW_BOOST, intensity - 1);
  const particleCount = KAME_PARTICLE_COUNT + boost * 2;
  const sparkCount = SPARK_COUNT + boost;
  const speed = 1 + boost * 0.28;

  if (!active) {
    return (
      <>
        <BaseEdge id={id} path={edgePath} style={{ ...style, stroke }} />
        {label && (
          <text>
            <textPath href={`#${id}`} startOffset="50%" textAnchor="middle" style={labelStyle} fill="currentColor">
              {label}
            </textPath>
          </text>
        )}
      </>
    );
  }

  return (
    <g className="topology-edge-electric">
      <defs>
        <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="2" result="noise">
            <animate attributeName="baseFrequency" values="0.8;1.4;0.8" dur="0.25s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <path
        d={edgePath}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={10 + boost * 3}
        strokeOpacity={0.35}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-halo"
      />
      <path
        d={edgePath}
        fill="none"
        stroke="#4ade80"
        strokeWidth={5 + boost * 1.6}
        strokeOpacity={0.85}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-plasma"
      />
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: "#f8fafc", strokeWidth: 2.2 + boost * 1.1, opacity: 1 }}
        className="topology-edge-kame"
      />
      {Array.from({ length: particleCount }, (_, i) => (
        <circle
          key={`${id}-p-${i}`}
          r={i % 2 === 0 ? 4 : 2.5}
          fill={i % 3 === 0 ? "#fde047" : i % 3 === 1 ? "#67e8f9" : "#fff"}
          opacity={0.95}
          style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }}
        >
          <animateMotion dur={`${(0.4 + i * 0.08) / speed}s`} repeatCount="indefinite" path={edgePath} begin={`${i * 0.09}s`} />
        </circle>
      ))}
      {Array.from({ length: sparkCount }, (_, i) => (
        <circle key={`${id}-s-${i}`} r={1.8} fill="#e0f2fe" opacity={0}>
          <animate
            attributeName="opacity"
            values="0;1;0;0;1;0"
            dur={`${(0.35 + (i % 3) * 0.1) / speed}s`}
            begin={`${i * 0.07}s`}
            repeatCount="indefinite"
          />
          <animateMotion dur={`${(0.28 + i * 0.05) / speed}s`} repeatCount="indefinite" path={edgePath} begin={`${i * 0.11}s`} />
        </circle>
      ))}
    </g>
  );
}

TopologyEdge.propTypes = {
  id: PropTypes.string,
  sourceX: PropTypes.number,
  sourceY: PropTypes.number,
  targetX: PropTypes.number,
  targetY: PropTypes.number,
  sourcePosition: PropTypes.string,
  targetPosition: PropTypes.string,
  style: PropTypes.object,
  data: PropTypes.object,
  label: PropTypes.string,
  labelStyle: PropTypes.object,
  labelBgStyle: PropTypes.object,
};

const nodeTypes = {
  provider: ProviderNode,
  router: RouterNode,
  connection: ConnectionNode,
  combo: ComboNode,
  model: ModelNode,
};
const edgeTypes = { topology: TopologyEdge };

const EDGE_STYLE = (active, last, error, warning = false) => {
  if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
  if (warning) return { stroke: "#f59e0b", strokeWidth: 2.5, opacity: 0.9 };
  if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
  if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
  return { stroke: "var(--color-border)", strokeWidth: 1, opacity: 0.3 };
};

// Circular provider graph with directional connection branches and collision relaxation.
function buildProvidersLayout(
  providers,
  activeSet,
  lastSet,
  clickable = false,
  activeConnections = new Map(),
  activeRequestCounts = new Map(),
  routingProviders = [],
  sessionTopology = { byProvider: new Map(), connectionRows: new Map() },
  configuredConnections = new Map(),
  positionOverrides = new Map()
) {
  const TAU = Math.PI * 2;
  const routerW = 120;
  const routerH = 44;
  const providerW = 180;
  const providerH = 64;
  const connectionW = 210;
  const connectionH = 48;
  const totalActiveRequests = [...activeRequestCounts.values()].reduce((sum, value) => sum + value, 0);
  const providerRows = Array.isArray(providers) ? providers.filter((provider) => provider?.provider) : [];

  if (providerRows.length === 0) {
    return {
      nodes: [{ id: "router", type: "router", position: { x: -routerW / 2, y: -routerH / 2 }, data: { activeCount: 0, activeRequests: 0 }, draggable: false }],
      edges: [],
    };
  }

  const descriptors = providerRows.map((provider) => {
    const providerKey = normalizeProviderId(provider.provider);
    const routingProvider = (Array.isArray(routingProviders) ? routingProviders : [])
      .find((row) => normalizeProviderId(row.provider) === providerKey);
    return {
      provider,
      providerKey,
      routingProvider,
      connections: mergeProviderConnections(
        provider,
        routingProvider,
        sessionTopology,
        configuredConnections.get(providerKey) || []
      ),
      weight: 1,
    };
  });
  const providerRadius = Math.max(
    300,
    ((providerW + 90) * descriptors.length) / TAU,
    130 * Math.sqrt(descriptors.length)
  );
  let cursor = -Math.PI / 2;

  for (const descriptor of descriptors) {
    descriptor.angle = cursor + Math.PI / descriptors.length;
    descriptor.providerPosition = {
      x: Math.cos(descriptor.angle) * providerRadius,
      y: Math.sin(descriptor.angle) * providerRadius,
    };
    cursor += TAU / descriptors.length;
  }

  const nodes = [{
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: activeSet.size, activeRequests: totalActiveRequests },
    draggable: false,
  }];
  const edges = [];
  const collisionNodes = [];
  const desiredPositions = new Map();

  for (const descriptor of descriptors) {
    const { provider, providerKey, routingProvider, connections } = descriptor;
    const config = getProviderConfig(provider.provider);
    const active = activeSet.has(providerKey);
    const last = !active && lastSet.has(providerKey);
    const providerId = `provider-${provider.provider}`;
    const connectionCount = activeConnections.get(providerKey)?.size || 0;
    const requestCount = activeRequestCounts.get(providerKey) || 0;
    const sessionCount = sessionTopology.byProvider.get(providerKey)?.size || 0;
    const baseRequests = Number(routingProvider?.requests) || connections.reduce((sum, connection) => sum + (Number(connection.requests) || 0), 0);
    const baseTokens = Number(routingProvider?.tokens) || connections.reduce((sum, connection) => sum + (Number(connection.tokens) || 0), 0);
    const liveMetrics = sessionTopology.metricsByProvider?.get(providerKey) || { requests: 0, tokens: 0 };
    const totalRequests = baseRequests + (Number(liveMetrics.requests) || 0);
    const totalTokens = baseTokens + (Number(liveMetrics.tokens) || 0);
    const failure = sessionTopology.failuresByProvider?.get(providerKey);

    nodes.push({
      id: providerId,
      type: "provider",
      position: { x: descriptor.providerPosition.x - providerW / 2, y: descriptor.providerPosition.y - providerH / 2 },
      data: {
        label: (config.name !== provider.provider ? config.name : null) || provider.nodeName || provider.name || provider.provider,
        color: config.color || "#6b7280",
        imageUrl: getProviderImageUrl(provider.provider),
        textIcon: config.textIcon || (provider.provider || "?").slice(0, 2).toUpperCase(),
        active,
        connectionCount,
        requestCount,
        sessionCount,
        totalRequests,
        totalTokens,
        failureAt: failure?.at || 0,
        failureKind: failure?.kind || null,
        failureMessage: failure?.message || null,
        role: connections.length > 0 ? "source" : undefined,
        clickable,
      },
      draggable: false,
    });
    collisionNodes.push({ id: providerId, kind: "provider", x: descriptor.providerPosition.x, y: descriptor.providerPosition.y, radius: Math.max(providerW, providerH) / 2 });

    const radialX = Math.cos(descriptor.angle);
    const radialY = Math.sin(descriptor.angle);
    const tangentX = -radialY;
    const tangentY = radialX;
    // Group connections into a compact two- or three-row block behind the
    // provider. The block follows the provider's radial direction, while the
    // rows themselves provide the inline fan needed for multiple accounts.
    const maxColumns = 3;
    const columns = Math.min(maxColumns, Math.max(2, Math.ceil(connections.length / 2)));
    const rowForwardGap = Math.abs(radialX) * connectionH + Math.abs(radialY) * connectionW + 30;
    const columnLateralGap = Math.abs(tangentX) * connectionW + Math.abs(tangentY) * connectionH + 30;
    connections.forEach((connection, connectionIndex) => {
      const connectionId = `session-${provider.provider}-${connection.connectionId || connection.name || connectionIndex}`;
      const row = Math.floor(connectionIndex / columns);
      const slot = connectionIndex % columns;
      const slotsInRow = Math.min(columns, connections.length - row * columns);
      const forward = 220 + row * rowForwardGap;
      const lateral = (slot - (slotsInRow - 1) / 2) * columnLateralGap;
      const center = {
        x: descriptor.providerPosition.x + radialX * forward + tangentX * lateral,
        y: descriptor.providerPosition.y + radialY * forward + tangentY * lateral,
      };
      const position = { x: center.x - connectionW / 2, y: center.y - connectionH / 2 };
      const sessionCountForConnection = Number(connection.sessionCount) || 0;
      const activeCountForConnection = Number(connection.activeCount) || 0;
      const connectionActive = sessionCountForConnection > 0 || activeCountForConnection > 0;
      const requestTotal = (Number(connection.requests) || 0) + (Number(connection.liveRequests) || 0);
      const tokenTotalForConnection = (Number(connection.tokens) || 0) + (Number(connection.liveTokens) || 0);
      const failure = connection.failureAt
        ? { at: connection.failureAt, kind: connection.failureKind, message: connection.failureMessage }
        : null;

      nodes.push({
        id: connectionId,
        type: "connection",
        position,
        data: {
          label: connection.name || connection.connectionId?.slice(0, 8) || "connection",
          provider: provider.provider,
          connectionId: connection.connectionId,
          requests: requestTotal,
          tokens: tokenTotalForConnection,
          failures: connection.failures || 0,
          lastUsed: connection.lastUsed,
          testStatus: connection.testStatus,
          cooldownUntil: connection.cooldownUntil,
          cooling: Boolean(connection.cooldownUntil && new Date(connection.cooldownUntil).getTime() > Date.now()),
          active: connectionActive,
          activeCount: activeCountForConnection,
          sessionCount: sessionCountForConnection,
          failureAt: failure?.at || 0,
          failureKind: failure?.kind || null,
          failureMessage: failure?.message || null,
          clickable: true,
        },
        draggable: false,
      });
      desiredPositions.set(connectionId, center);
      collisionNodes.push({ id: connectionId, kind: "connection", x: center.x, y: center.y, radius: Math.max(connectionW, connectionH) / 2 });
    });
  }

  // Relax only the child fan-out. Providers remain anchored to the expanding
  // circle, while nearby children are pushed apart instead of overlapping.
  for (let iteration = 0; iteration < 18; iteration += 1) {
    for (let leftIndex = 0; leftIndex < collisionNodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < collisionNodes.length; rightIndex += 1) {
        const left = collisionNodes[leftIndex];
        const right = collisionNodes[rightIndex];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const minimum = left.radius + right.radius + 26;
        if (distance >= minimum) continue;
        const push = (minimum - distance) / 2;
        const nx = dx / distance;
        const ny = dy / distance;
        left.x -= nx * push;
        left.y -= ny * push;
        right.x += nx * push;
        right.y += ny * push;
      }
    }

    for (const collisionNode of collisionNodes) {
      if (collisionNode.kind === "provider") {
        const length = Math.hypot(collisionNode.x, collisionNode.y) || 1;
        collisionNode.x = (collisionNode.x / length) * providerRadius;
        collisionNode.y = (collisionNode.y / length) * providerRadius;
      } else {
        const desired = desiredPositions.get(collisionNode.id);
        if (desired) {
          collisionNode.x += (desired.x - collisionNode.x) * 0.08;
          collisionNode.y += (desired.y - collisionNode.y) * 0.08;
        }
      }
    }
  }

  const collisionById = new Map(collisionNodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.id === "router") continue;
    const override = positionOverrides.get(node.id);
    if (override) {
      node.position = { ...override };
      continue;
    }
    const collision = collisionById.get(node.id);
    if (!collision) continue;
    const width = node.type === "provider" ? providerW : connectionW;
    const height = node.type === "provider" ? providerH : connectionH;
    node.position = { x: collision.x - width / 2, y: collision.y - height / 2 };
  }

  const handleFor = (dx, dy, source = false) => {
    const handle = Math.abs(dx) >= Math.abs(dy)
      ? (dx >= 0 ? "right" : "left")
      : (dy >= 0 ? "bottom" : "top");
    return source ? `out-${handle}` : handle;
  };

  for (const descriptor of descriptors) {
    const providerId = `provider-${descriptor.provider.provider}`;
    const providerNode = nodes.find((node) => node.id === providerId);
    const providerCenter = { x: providerNode.position.x + providerW / 2, y: providerNode.position.y + providerH / 2 };
    const providerFailure = sessionTopology.failuresByProvider?.get(descriptor.providerKey);
    edges.push({
      id: `e-${providerId}`,
      type: "topology",
      source: "router",
      sourceHandle: handleFor(providerCenter.x, providerCenter.y),
      target: providerId,
      targetHandle: handleFor(-providerCenter.x, -providerCenter.y),
      animated: false,
      data: { active: activeSet.has(descriptor.providerKey), intensity: Math.max(1, sessionTopology.byProvider.get(descriptor.providerKey)?.size || 0) },
      style: EDGE_STYLE(
        activeSet.has(descriptor.providerKey),
        lastSet.has(descriptor.providerKey),
        providerFailure?.kind === "error",
        providerFailure?.kind === "warning"
      ),
    });

    for (const [connectionIndex, connection] of descriptor.connections.entries()) {
      const connectionId = `session-${descriptor.provider.provider}-${connection.connectionId || connection.name || connectionIndex}`;
      const connectionNode = nodes.find((node) => node.id === connectionId);
      if (!connectionNode) continue;
      const connectionCenter = { x: connectionNode.position.x + connectionW / 2, y: connectionNode.position.y + connectionH / 2 };
      const dx = connectionCenter.x - providerCenter.x;
      const dy = connectionCenter.y - providerCenter.y;
      const connectionActive = connectionNode.data.active;
      edges.push({
        id: `e-${providerId}-${connectionId}`,
        type: "topology",
        source: providerId,
        sourceHandle: handleFor(dx, dy, true),
        target: connectionId,
        targetHandle: handleFor(-dx, -dy),
        animated: false,
        data: { active: connectionActive, intensity: Math.max(1, connectionNode.data.sessionCount, connectionNode.data.activeCount) },
        label: connectionNode.data.sessionCount > 0
          ? `${connectionNode.data.sessionCount} session${connectionNode.data.sessionCount > 1 ? "s" : ""}`
          : connectionNode.data.requests > 0 ? `${fmtCompact(connectionNode.data.requests)} req` : undefined,
        style: EDGE_STYLE(
          connectionActive,
          false,
          connectionNode.data.failureKind === "error"
            || (!connectionActive && connectionNode.data.testStatus === "unavailable"),
          connectionNode.data.failureKind === "warning" || connectionNode.data.cooling
        ),
      });
    }
  }

  return { nodes, edges };
}

// Pools mode: each provider on the left, its accounts stacked to the right.
function buildPoolsLayout(providers, activeRequests = [], sessionTopology = {}) {
  const nodes = [];
  const edges = [];
  const laneGap = 28;
  const connGap = 58;
  const providerNodeH = 56;

  // Active requests can identify an account by UUID or display name. Keep both
  // forms so a live request highlights the same pool node as the live canvas.
  const activeRequestsByProvider = new Map();
  for (const request of activeRequests || []) {
    const providerKey = normalizeProviderId(request.provider);
    const rows = activeRequestsByProvider.get(providerKey) || [];
    rows.push(request);
    activeRequestsByProvider.set(providerKey, rows);
  }

  let y = 0;
  const providerRows = Array.isArray(providers) ? providers.filter((provider) => provider?.provider) : [];
  for (const provider of providerRows) {
    const config = getProviderConfig(provider.provider);
    const connections = Array.isArray(provider.connections) ? provider.connections : [];
    const laneHeight = Math.max(providerNodeH, connections.length * connGap);
    const laneCenter = y + laneHeight / 2;
    const providerId = `pool-provider-${provider.provider}`;
    const providerKey = normalizeProviderId(provider.provider);
    const providerActiveRequests = activeRequestsByProvider.get(providerKey) || [];
    const liveMetrics = sessionTopology.metricsByProvider?.get(providerKey) || { requests: 0, tokens: 0 };
    const providerFailure = sessionTopology.failuresByProvider?.get(providerKey);
    const baseRequests = Number(provider.requests) || connections.reduce((sum, connection) => sum + (Number(connection.requests) || 0), 0);
    const baseTokens = Number(provider.tokens) || connections.reduce((sum, connection) => sum + (Number(connection.tokens) || 0), 0);
    const totalRequests = baseRequests + (Number(liveMetrics.requests) || 0);
    const totalTokens = baseTokens + (Number(liveMetrics.tokens) || 0);

    nodes.push({
      id: providerId,
      type: "provider",
      position: { x: 0, y: laneCenter - providerNodeH / 2 },
      data: {
        label: provider.name || provider.provider,
        subtitle: `${fmtCompact(totalRequests)} req · ${fmtCompact(totalTokens)} tok`,
        color: config.color || "#6b7280",
        imageUrl: getProviderImageUrl(provider.provider),
        textIcon: config.textIcon || provider.provider.slice(0, 2).toUpperCase(),
        active: providerActiveRequests.length > 0 || sessionTopology.byProvider?.has(providerKey),
        totalRequests,
        totalTokens,
        failureAt: providerFailure?.at || 0,
        failureKind: providerFailure?.kind || null,
        failureMessage: providerFailure?.message || null,
        clickable: true,
        role: "source",
      },
      draggable: false,
    });

    connections.forEach((conn, index) => {
      const connId = `conn-${provider.provider}-${conn.connectionId || index}`;
      const accountName = conn.name || conn.connectionId?.slice(0, 8) || "account";
      const liveRow = [...(sessionTopology.liveRows?.values() || [])].find((row) => (
        row.provider === providerKey
        && (
          (conn.connectionId && row.connectionId === conn.connectionId)
          || connectionNameKey(row.connectionName) === connectionNameKey(accountName)
        )
      ));
      const requestTotal = (Number(conn.requests) || 0) + (Number(liveRow?.liveRequests) || 0);
      const tokenTotalForConnection = (Number(conn.tokens) || 0) + (Number(liveRow?.liveTokens) || 0);
      const active = providerActiveRequests.some((request) => (
        (conn.connectionId && request.connectionId === conn.connectionId)
        || connectionNameKey(request.account || request.connectionName) === connectionNameKey(accountName)
      ));
      const activeCount = providerActiveRequests
        .filter((request) => (
          (conn.connectionId && request.connectionId === conn.connectionId)
          || connectionNameKey(request.account || request.connectionName) === connectionNameKey(accountName)
        ))
        .reduce((sum, request) => sum + (Number(request.count) > 0 ? Number(request.count) : 1), 0);
      const failure = liveRow?.failureAt
        ? { at: liveRow.failureAt, kind: liveRow.failureKind, message: liveRow.failureMessage }
        : null;
      nodes.push({
        id: connId,
        type: "connection",
        position: { x: 380, y: y + index * connGap },
        data: {
          label: accountName,
          provider: provider.provider,
          connectionId: conn.connectionId,
          requests: requestTotal,
          tokens: tokenTotalForConnection,
          failures: conn.failures || 0,
          lastUsed: conn.lastUsed,
          testStatus: conn.testStatus,
          cooldownUntil: conn.cooldownUntil,
          cooling: Boolean(conn.cooldownUntil && new Date(conn.cooldownUntil).getTime() > Date.now()),
          active,
          activeCount,
          failureAt: failure?.at || 0,
          failureKind: failure?.kind || null,
          failureMessage: failure?.message || null,
          clickable: true,
        },
        draggable: false,
      });
      edges.push({
        id: `e-${providerId}-${connId}`,
        type: "topology",
        source: providerId,
        sourceHandle: "out-right",
        target: connId,
        targetHandle: "left",
        animated: false,
        data: { active, intensity: activeCount },
        label: requestTotal ? `${fmtCompact(requestTotal)} req` : undefined,
        style: EDGE_STYLE(
          active,
          false,
          failure?.kind === "error" || (!active && conn.testStatus === "unavailable"),
          failure?.kind === "warning"
            || Boolean(conn.cooldownUntil && new Date(conn.cooldownUntil).getTime() > Date.now())
        ),
      });
    });

    y += laneHeight + laneGap;
  }

  return { nodes, edges };
}

// Combo → models → provider
function buildCombosLayout(combos) {
  const nodes = [];
  const edges = [];
  const modelGap = 60;
  let y = 0;

  for (const combo of combos) {
    const models = combo.models || [];
    const laneHeight = Math.max(64, models.length * modelGap);
    const laneCenter = y + laneHeight / 2;
    const comboId = `combo-${combo.name}`;
    const ok = models.reduce((sum, m) => sum + (m.ok || 0), 0);
    const failed = models.reduce((sum, m) => sum + (m.failed || 0), 0);

    nodes.push({
      id: comboId,
      type: "combo",
      position: { x: 0, y: laneCenter - 32 },
      data: {
        label: combo.name,
        kind: combo.kind || "combo",
        strategy: combo.strategy || "fallback",
        attempts: combo.attempts || 0,
        ok,
        failed,
        clickable: true,
      },
      draggable: false,
    });

    models.forEach((model, index) => {
      const modelId = `cmodel-${combo.name}-${index}`;
      const providerId = providerOfModel(model.model);
      const config = getProviderConfig(providerId);
      const nodeY = y + index * modelGap;
      nodes.push({
        id: modelId,
        type: "model",
        position: { x: 360, y: nodeY },
        data: {
          label: model.model,
          providerLabel: config.name || providerId,
          ok: model.ok || 0,
          failed: model.failed || 0,
          active: false,
          clickable: true,
        },
        draggable: false,
      });
      edges.push({
        id: `e-${comboId}-${modelId}`,
        type: "topology",
        source: comboId,
        sourceHandle: "out-right",
        target: modelId,
        targetHandle: "left",
        animated: false,
        data: { active: false },
        style: EDGE_STYLE(false, false, (model.failed || 0) > 0 && (model.ok || 0) === 0),
        label: model.failed > 0 && model.ok === 0 ? "failed" : model.ok > 0 ? "ok" : undefined,
      });

      const modelProviderId = `cmodel-provider-${combo.name}-${index}`;
      nodes.push({
        id: modelProviderId,
        type: "provider",
        position: { x: 720, y: nodeY - 6 },
        data: {
          label: config.name || providerId,
          color: config.color || "#6b7280",
          imageUrl: getImageUrlSafe(providerId),
          textIcon: config.textIcon || providerId.slice(0, 2).toUpperCase(),
          active: false,
          clickable: true,
        },
        draggable: false,
      });
      edges.push({
        id: `e-${modelId}-${modelProviderId}`,
        type: "topology",
        source: modelId,
        sourceHandle: "out-right",
        target: modelProviderId,
        targetHandle: "left",
        animated: false,
        data: { active: false },
        style: EDGE_STYLE(false, false, false),
      });
    });

    y += laneHeight + 30;
  }

  return { nodes, edges };
}

// getProviderIconSrc itself is safe; keep a wrapper so a bad id never throws.
function getImageUrlSafe(providerId) {
  try {
    return getProviderImageUrl(providerId);
  } catch {
    return null;
  }
}

// Fall back to a single synthetic connection per provider when routing data
// has not been recorded for this window yet.
function providersToPoolRows(providers, routing) {
  const configured = (Array.isArray(providers) ? providers : []).filter((provider) => provider?.provider);
  const configuredByProvider = new Map(configured.map((provider) => [normalizeProviderId(provider.provider), provider]));
  if (Array.isArray(routing?.providers) && routing.providers.length) {
    return routing.providers.map((row) => {
      const provider = configuredByProvider.get(normalizeProviderId(row.provider));
      const connections = new Map();
      for (const connection of [...(provider?.connections || []), ...(row.connections || [])]) {
        const key = connection.connectionId || connection.id || connection.name;
        if (key) connections.set(key, { ...connection, connectionId: connection.connectionId || connection.id || null });
      }
      return { ...row, connections: [...connections.values()] };
    });
  }
  return configured.map((provider) => ({
    provider: provider.provider,
    name: getProviderConfig(provider.provider).name || provider.name || provider.provider,
    requests: 0,
    tokens: 0,
    failures: 0,
    connections: provider.connections || (provider.id ? [{ connectionId: provider.id, name: provider.name || provider.id, requests: 0, tokens: 0, failures: 0 }] : []),
  }));
}

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  period = "7d",
  onSelectProvider,
  onSelectConnection,
  onSelectCombo,
  onSelectModel,
}) {
  const [mode, setMode] = useState("providers");
  const [routing, setRouting] = useState(null);
  const [routingSnapshot, setRoutingSnapshot] = useState({ period: null, at: 0 });
  const [liveRequests, setLiveRequests] = useState([]);
  const routingLoadedAt = routingSnapshot.period === period ? routingSnapshot.at : 0;

  const activeKey = useMemo(
    () => [...new Set([
      ...activeRequests.map((r) => normalizeProviderId(r.provider)).filter(Boolean),
      ...activeLiveRequests(liveRequests).map((r) => normalizeProviderId(r.provider)).filter(Boolean),
    ])].sort().join(","),
    [activeRequests, liveRequests]
  );
  const lastKey = lastProvider ? normalizeProviderId(lastProvider) : "";
  const rawActiveSet = useMemo(() => new Set(activeKey ? activeKey.split(",") : []), [activeKey]);
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);

  const activeSet = rawActiveSet;

  // In-flight requests per provider and per connection, plus the distinct
  // connections (accounts) each provider is using. One active entry is per
  // (account, model) and may carry count > 1 for concurrent sessions.
  const activeTotals = useMemo(() => {
    const requestsByProvider = new Map();
    const connectionsByProvider = new Map();
    let total = 0;
    for (const request of activeRequests || []) {
      const provider = normalizeProviderId(request.provider);
      if (!provider) continue;
      const count = Number(request.count) > 0 ? Number(request.count) : 1;
      total += count;
      requestsByProvider.set(provider, (requestsByProvider.get(provider) || 0) + count);
      let accounts = connectionsByProvider.get(provider);
      if (!accounts) {
        accounts = new Set();
        connectionsByProvider.set(provider, accounts);
      }
      accounts.add(request.connectionId || request.account || "unknown");
    }
    return { requestsByProvider, connectionsByProvider, total };
  }, [activeRequests]);

  useEffect(() => {
    let cancelled = false;
    let streamConnected = false;
    let stream;
    const applyPayload = (payload) => {
      if (!cancelled && payload && !payload.error && Array.isArray(payload.requests)) {
        setLiveRequests(payload.requests);
      }
    };
    const load = () => {
      fetch("/api/usage/live-requests", { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error(`Live requests failed: ${res.status}`);
          return res.json();
        })
        .then(applyPayload)
        .catch(() => {});
    };

    // The stream pushes a snapshot and then one coalesced update for every
    // routing event. Keep the REST poll as a recovery path for older browsers
    // or a temporarily unavailable SSE connection.
    load();
    try {
      stream = new EventSource("/api/usage/live-requests/stream");
      const handleStreamEvent = (event) => {
        streamConnected = true;
        try {
          applyPayload(JSON.parse(event.data));
        } catch {
          // Ignore malformed frames; the next update still carries a full view.
        }
      };
      stream.addEventListener("snapshot", handleStreamEvent);
      stream.addEventListener("update", handleStreamEvent);
      stream.onopen = () => { streamConnected = true; };
      stream.onerror = () => { streamConnected = false; };
    } catch {
      stream = null;
    }

    const fallbackTimer = setInterval(() => {
      if (!streamConnected) load();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(fallbackTimer);
      stream?.close();
    };
  }, []);

  const sessionTopology = useMemo(
    () => buildSessionTopology(liveRequests, activeRequests, routingLoadedAt),
    [liveRequests, activeRequests, routingLoadedAt]
  );

  // Routing data powers the provider fan-out as well as pools + combos.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/usage/routing?period=${encodeURIComponent(period)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Routing data failed: ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        if (cancelled) return;
        if (payload && !payload.error) setRouting(payload);
        setRoutingSnapshot({ period, at: Date.now() });
      })
      .catch(() => {
        if (!cancelled) setRoutingSnapshot({ period, at: Date.now() });
      });
    return () => { cancelled = true; };
  }, [period]);

  const routingLoading = mode !== "providers" && routing === null;

  const clickableProviders = typeof onSelectProvider === "function";
  const configuredConnections = useMemo(() => {
    const map = new Map();
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (!provider?.provider) continue;
      map.set(normalizeProviderId(provider.provider), Array.isArray(provider.connections) ? provider.connections : []);
    }
    return map;
  }, [providers]);

  // Compute the structural layout only from configured/historical connections.
  // Live request state can then update badges and edges without recalculating
  // the position of any node already visible on the canvas.
  const stableProviderLayout = useMemo(() => buildProvidersLayout(
    providers,
    new Set(),
    new Set(),
    clickableProviders,
    new Map(),
    new Map(),
    routing?.providers || [],
    { byProvider: new Map(), connectionRows: new Map() },
    configuredConnections
  ), [providers, routing, configuredConnections, clickableProviders]);
  const stableNodePositions = useMemo(
    () => new Map(stableProviderLayout.nodes.map((node) => [node.id, node.position])),
    [stableProviderLayout]
  );

  const graph = useMemo(() => {
    let nextGraph;
    if (mode === "pools") {
      const rows = providersToPoolRows(providers, routing);
      nextGraph = buildPoolsLayout(rows, activeRequests, sessionTopology);
    } else if (mode === "combos") {
      nextGraph = buildCombosLayout(routing?.combos || []);
    } else {
      nextGraph = buildProvidersLayout(
        providers,
        activeSet,
        lastSet,
        clickableProviders,
        activeTotals.connectionsByProvider,
        activeTotals.requestsByProvider,
        routing?.providers || [],
        sessionTopology,
        configuredConnections,
        stableNodePositions
      );
    }
    return nextGraph;
  }, [mode, providers, routing, activeSet, lastSet, clickableProviders, activeRequests, activeTotals, sessionTopology, configuredConnections, stableNodePositions]);

  const rfInstance = useRef(null);
  const didFitInitialGraph = useRef(false);
  const onInit = useCallback((instance) => {
    rfInstance.current = instance;
    setTimeout(() => instance.fitView(FIT_VIEW_OPTIONS), 50);
  }, []);

  const onNodeClick = useCallback(
    (_event, node) => {
      const type = node?.type;
      const id = node?.id || "";
      if (type === "provider" && id.startsWith("pool-provider-")) {
        onSelectProvider?.(id.slice("pool-provider-".length));
        return;
      }
      if (type === "provider" && id.startsWith("cmodel-provider-")) {
        onSelectProvider?.(node.data?.label);
        return;
      }
      if (type === "provider" && id.startsWith("provider-")) {
        onSelectProvider?.(id.slice("provider-".length));
        return;
      }
      if (type === "connection") {
        onSelectConnection?.(node.data?.connectionId, node.data?.provider);
        return;
      }
      if (type === "combo" && id.startsWith("combo-")) {
        onSelectCombo?.(id.slice("combo-".length));
        return;
      }
      if (type === "model" && node.data?.label) {
        onSelectModel?.(node.data.label);
      }
    },
    [onSelectProvider, onSelectConnection, onSelectCombo, onSelectModel]
  );

  useEffect(() => {
    if (didFitInitialGraph.current || graph.nodes.length === 0) return undefined;
    didFitInitialGraph.current = true;
    const id = setTimeout(() => rfInstance.current?.fitView(FIT_VIEW_OPTIONS), 50);
    return () => clearTimeout(id);
  }, [graph.nodes.length]);

  const emptyMessages = {
    providers: "No providers connected",
    pools: routingLoading ? "Loading pools…" : "No account activity recorded in this window",
    combos: routingLoading ? "Loading combos…" : "No combos or capacity fallbacks in this window",
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-text-muted">hub</span>
          <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Routing canvas</span>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1">
          {MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setMode(option.value)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mode === option.value ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className={`w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 ${mode === "providers" ? "h-[360px] sm:h-[560px]" : "h-[420px] sm:h-[560px]"}`}
      >
        {graph.nodes.length === 0 || (mode === "providers" && providers.length === 0) ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            {emptyMessages[mode]}
          </div>
        ) : (
          <ReactFlow
            key={mode}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            minZoom={0.1}
            maxZoom={2}
            onInit={onInit}
            proOptions={{ hideAttribution: true }}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick
            preventScrolling={false}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            onNodeClick={onNodeClick}
          >
            <Controls showInteractive={false} className="react-flow-controls-custom" />
          </ReactFlow>
        )}
      </div>

      {mode === "providers" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-cyan-400" /> live session on a connection</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" /> historical connection</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" /> brief limit blink</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-danger" /> real error blink</span>
          <span>provider badge = sessions · child node = connection</span>
        </div>
      )}

      {mode !== "providers" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" /> healthy account</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" /> brief limit / cooldown blink</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-danger" /> real routing error</span>
          <span>click a provider, account, combo or model to open its requests</span>
        </div>
      )}
    </div>
  );
}

ProviderTopology.propTypes = {
  providers: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    provider: PropTypes.string,
    name: PropTypes.string,
  })),
  activeRequests: PropTypes.arrayOf(PropTypes.shape({
    provider: PropTypes.string,
    model: PropTypes.string,
    connectionId: PropTypes.string,
    account: PropTypes.string,
    count: PropTypes.number,
  })),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
  period: PropTypes.string,
  onSelectProvider: PropTypes.func,
  onSelectConnection: PropTypes.func,
  onSelectCombo: PropTypes.func,
  onSelectModel: PropTypes.func,
};
