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
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { fmtCompact, fmtTime } from "./format";

// Force-stop FE animation if a provider stays active longer than this
const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;

// Kame + electric particles along active edges
const KAME_PARTICLE_COUNT = 6;
const SPARK_COUNT = 5;

const MODES = [
  { value: "providers", label: "Providers" },
  { value: "pools", label: "Pools" },
  { value: "combos", label: "Combos" },
];

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return getProviderIconSrc(providerId);
}

function providerOfModel(model) {
  if (typeof model !== "string" || !model.includes("/")) return "unknown";
  return model.slice(0, model.indexOf("/"));
}

// Custom provider node - rectangle with image + name
function ProviderNode({ data }) {
  const { label, color, imageUrl, textIcon, active, activeCount, clickable, subtitle, role } = data;
  const [imgError, setImgError] = useState(false);
  const isSource = role === "source";
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      style={{
        borderColor: active ? color : "var(--color-border)",
        boxShadow: active ? `0 0 16px ${color}40` : "none",
        minWidth: "150px",
        cursor: clickable ? "pointer" : undefined,
      }}
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
          style={{ color: active ? color : "var(--color-text)" }}
        >
          {label}
        </span>
        {subtitle && <span className="block text-[11px] text-text-muted">{subtitle}</span>}
      </div>

      {/* Active indicator: live request count for this provider, then ping dot */}
      {active && activeCount > 0 && (
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
          style={{ backgroundColor: `${color}20`, color }}
          title={`${activeCount} in-flight request${activeCount > 1 ? "s" : ""}`}
        >
          {activeCount}
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
  const { label, requests, tokens, failures, lastUsed, testStatus, cooldownUntil, active, activeCount, clickable } = data;
  const cooling = cooldownUntil && new Date(cooldownUntil).getTime() > Date.now();
  const ok = !cooling && failures === 0 && testStatus !== "unavailable";
  return (
    <div
      className="flex min-w-[180px] max-w-[220px] items-center gap-2 rounded-lg border bg-bg px-3 py-2 transition-colors"
      style={{
        borderColor: active ? "#22d3ee" : cooling ? "#f59e0b" : "var(--color-border)",
        boxShadow: active ? "0 0 12px #22d3ee40" : "none",
        cursor: clickable ? "pointer" : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <span className={`block size-2 shrink-0 rounded-full ${active ? "bg-cyan-400" : cooling ? "bg-warning" : ok ? "bg-emerald-500" : "bg-danger"}`} />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-text-main">{label}</span>
        <span className="block text-[10px] text-text-muted">
          {fmtCompact(requests)} req
          {tokens > 0 ? ` · ${fmtCompact(tokens)} tok` : ""}
          {failures > 0 ? ` · ${failures} failed` : ""}
          {lastUsed ? ` · ${fmtTime(lastUsed)}` : ""}
        </span>
      </div>
      {active && activeCount > 0 && (
        <span
          className="shrink-0 rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-cyan-600 dark:text-cyan-400"
          title={`${activeCount} in-flight request${activeCount > 1 ? "s" : ""}`}
        >
          {activeCount}
        </span>
      )}
      {cooling && (
        <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">cooling</span>
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
          title={`${data.activeCount} in-flight request${data.activeCount > 1 ? "s" : ""} across ${data.activeProviders || 1} provider${(data.activeProviders || 1) > 1 ? "s" : ""}`}
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
        strokeWidth={10}
        strokeOpacity={0.35}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-halo"
      />
      <path
        d={edgePath}
        fill="none"
        stroke="#4ade80"
        strokeWidth={5}
        strokeOpacity={0.85}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-plasma"
      />
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: "#f8fafc", strokeWidth: 2.2, opacity: 1 }}
        className="topology-edge-kame"
      />
      {Array.from({ length: KAME_PARTICLE_COUNT }, (_, i) => (
        <circle
          key={`${id}-p-${i}`}
          r={i % 2 === 0 ? 4 : 2.5}
          fill={i % 3 === 0 ? "#fde047" : i % 3 === 1 ? "#67e8f9" : "#fff"}
          opacity={0.95}
          style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }}
        >
          <animateMotion dur={`${0.4 + i * 0.08}s`} repeatCount="indefinite" path={edgePath} begin={`${i * 0.09}s`} />
        </circle>
      ))}
      {Array.from({ length: SPARK_COUNT }, (_, i) => (
        <circle key={`${id}-s-${i}`} r={1.8} fill="#e0f2fe" opacity={0}>
          <animate
            attributeName="opacity"
            values="0;1;0;0;1;0"
            dur={`${0.35 + (i % 3) * 0.1}s`}
            begin={`${i * 0.07}s`}
            repeatCount="indefinite"
          />
          <animateMotion dur={`${0.28 + i * 0.05}s`} repeatCount="indefinite" path={edgePath} begin={`${i * 0.11}s`} />
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

const EDGE_STYLE = (active, last, error) => {
  if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
  if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
  if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
  return { stroke: "var(--color-border)", strokeWidth: 1, opacity: 0.3 };
};

// Place N nodes evenly along an ellipse around the router center.
function buildProvidersLayout(providers, activeSet, lastSet, errorSet, clickable = false, activeCounts = new Map(), totalActive = 0) {
  const nodeW = 180;
  const nodeH = 30;
  const routerW = 120;
  const routerH = 44;
  const nodeGap = 24;
  const count = providers.length;

  const minRx = ((nodeW + nodeGap) * count) / (2 * Math.PI);
  const rx = Math.max(320, minRx);
  const ry = Math.max(200, rx * 0.55);
  if (count === 0) {
    return {
      nodes: [{ id: "router", type: "router", position: { x: 0, y: 0 }, data: { activeCount: 0 }, draggable: false }],
      edges: [],
    };
  }

  const nodes = [];
  const edges = [];
  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: totalActive, activeProviders: activeSet.size },
    draggable: false,
  });

  providers.forEach((p, i) => {
    const config = getProviderConfig(p.provider);
    const active = activeSet.has(p.provider?.toLowerCase());
    const last = !active && lastSet.has(p.provider?.toLowerCase());
    const error = !active && errorSet.has(p.provider?.toLowerCase());
    const nodeId = `provider-${p.provider}`;
    const providerActiveCount = activeCounts.get((p.provider || "").toLowerCase()) || 0;
    const data = {
      label: (config.name !== p.provider ? config.name : null) || p.nodeName || p.name || p.provider,
      color: config.color || "#6b7280",
      imageUrl: getProviderImageUrl(p.provider),
      textIcon: config.textIcon || (p.provider || "?").slice(0, 2).toUpperCase(),
      active,
      activeCount: providerActiveCount,
      clickable,
    };

    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    let sourceHandle, targetHandle;
    if (Math.abs(angle + Math.PI / 2) < Math.PI / 4 || Math.abs(angle - 3 * Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "top"; targetHandle = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "bottom"; targetHandle = "top";
    } else if (cx > 0) {
      sourceHandle = "right"; targetHandle = "left";
    } else {
      sourceHandle = "left"; targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      data,
      draggable: false,
    });
    edges.push({
      id: `e-${nodeId}`,
      type: "topology",
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      animated: false,
      data: { active },
      style: EDGE_STYLE(active, last, error),
    });
  });

  return { nodes, edges };
}

// Lanes: each provider on the left, its accounts stacked to the right.
function buildPoolsLayout(providers, activeRequests = []) {
  const nodes = [];
  const edges = [];
  const laneGap = 28;
  const connGap = 58;
  const providerNodeH = 56;

  // account names currently serving a request, keyed by provider
  const activeAccounts = new Set(
    (activeRequests || []).map((r) => `${(r.provider || "").toLowerCase()}|${r.account || ""}`)
  );
  // in-flight request count per account (same account can serve several sessions)
  const activeCounts = new Map();
  for (const request of activeRequests || []) {
    const key = `${(request.provider || "").toLowerCase()}|${request.account || ""}`;
    const count = Number(request.count) > 0 ? Number(request.count) : 1;
    activeCounts.set(key, (activeCounts.get(key) || 0) + count);
  }

  let y = 0;
  for (const provider of providers) {
    const config = getProviderConfig(provider.provider);
    const connections = provider.connections || [];
    const laneHeight = Math.max(providerNodeH, connections.length * connGap);
    const laneCenter = y + laneHeight / 2;
    const providerId = `pool-provider-${provider.provider}`;

    nodes.push({
      id: providerId,
      type: "provider",
      position: { x: 0, y: laneCenter - providerNodeH / 2 },
      data: {
        label: provider.name || provider.provider,
        subtitle: `${fmtCompact(provider.tokens)} tok · ${provider.failures} failed`,
        color: config.color || "#6b7280",
        imageUrl: getProviderImageUrl(provider.provider),
        textIcon: config.textIcon || provider.provider.slice(0, 2).toUpperCase(),
        active: activeSet.has(provider.provider?.toLowerCase()),
        clickable: true,
        role: "source",
      },
      draggable: false,
    });

    connections.forEach((conn, index) => {
      const connId = `conn-${provider.provider}-${conn.connectionId || index}`;
      const accountName = conn.name || conn.connectionId?.slice(0, 8) || "account";
      const accountKey = `${(provider.provider || "").toLowerCase()}|${accountName}`;
      const active = activeAccounts.has(accountKey);
      nodes.push({
        id: connId,
        type: "connection",
        position: { x: 380, y: y + index * connGap },
        data: {
          label: accountName,
          provider: provider.provider,
          connectionId: conn.connectionId,
          requests: conn.requests || 0,
          tokens: conn.tokens || 0,
          failures: conn.failures || 0,
          lastUsed: conn.lastUsed,
          testStatus: conn.testStatus,
          cooldownUntil: conn.cooldownUntil,
          active,
          activeCount: activeCounts.get(accountKey) || 0,
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
        data: { active },
        label: conn.requests ? `${fmtCompact(conn.requests)} req` : undefined,
        style: EDGE_STYLE(active, false, (conn.failures || 0) > 0 && !active),
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
  if (routing?.providers?.length) return routing.providers;
  return (providers || []).map((p) => ({
    provider: p.provider,
    name: getProviderConfig(p.provider).name || p.name || p.provider,
    requests: 0,
    tokens: 0,
    failures: 0,
    connections: p.id ? [{ connectionId: p.id, name: p.name || p.id, requests: 0, tokens: 0, failures: 0 }] : [],
  }));
}

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
  period = "7d",
  onSelectProvider,
  onSelectConnection,
  onSelectCombo,
  onSelectModel,
}) {
  const [mode, setMode] = useState("providers");
  const [routing, setRouting] = useState(null);

  const activeKey = useMemo(
    () => activeRequests.map((r) => r.provider?.toLowerCase()).filter(Boolean).sort().join(","),
    [activeRequests]
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";
  const rawActiveSet = useMemo(() => new Set(activeKey ? activeKey.split(",") : []), [activeKey]);
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set(errorKey ? [errorKey] : []), [errorKey]);

  const firstSeenRef = useRef({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const seen = firstSeenRef.current;
    const now = Date.now();
    for (const p of rawActiveSet) if (!seen[p]) seen[p] = now;
    for (const p of Object.keys(seen)) if (!rawActiveSet.has(p)) delete seen[p];
  }, [rawActiveSet]);

  useEffect(() => {
    if (rawActiveSet.size === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [rawActiveSet]);

  const activeSet = useMemo(() => {
    const now = Date.now();
    const filtered = new Set();
    for (const p of rawActiveSet) {
      const ts = firstSeenRef.current[p];
      if (!ts || now - ts < FE_ACTIVE_TIMEOUT_MS) filtered.add(p);
    }
    return filtered;
  }, [rawActiveSet, tick]);

  // In-flight requests per provider and overall. One entry per (account, model)
  // can carry a count > 1 when the same provider serves several concurrent
  // sessions, so count requests rather than distinct providers.
  const activeTotals = useMemo(() => {
    const byProvider = new Map();
    let total = 0;
    for (const request of activeRequests || []) {
      const provider = (request.provider || "").toLowerCase();
      const count = Number(request.count) > 0 ? Number(request.count) : 1;
      total += count;
      if (provider) byProvider.set(provider, (byProvider.get(provider) || 0) + count);
    }
    return { byProvider, total };
  }, [activeRequests]);

  // Routing data powers pools + combos modes.
  useEffect(() => {
    if (mode === "providers") return;
    let cancelled = false;
    fetch(`/api/usage/routing?period=${encodeURIComponent(period)}`)
      .then((res) => res.json())
      .then((payload) => { if (!cancelled && payload && !payload.error) setRouting(payload); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mode, period]);

  const routingLoading = mode !== "providers" && routing === null;

  const clickableProviders = typeof onSelectProvider === "function";

  const graph = useMemo(() => {
    if (mode === "pools") {
      const rows = providersToPoolRows(providers, routing);
      return buildPoolsLayout(rows, activeRequests);
    }
    if (mode === "combos") {
      return buildCombosLayout(routing?.combos || []);
    }
    return buildProvidersLayout(
      providers,
      activeSet,
      lastSet,
      errorSet,
      clickableProviders,
      activeTotals.byProvider,
      activeTotals.total
    );
  }, [mode, providers, routing, activeSet, lastSet, errorSet, clickableProviders, activeRequests, activeTotals]);

  const graphKey = useMemo(
    () => `${mode}:${graph.nodes.length}:${providers.map((p) => p.provider).sort().join(",")}`,
    [mode, graph.nodes.length, providers]
  );

  const rfInstance = useRef(null);
  const containerRef = useRef(null);
  const fitOpts = { padding: 0.2, duration: 200 };
  const onInit = useCallback((instance) => {
    rfInstance.current = instance;
    setTimeout(() => instance.fitView(fitOpts), 50);
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
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (rfInstance.current) rfInstance.current.fitView(fitOpts);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (rfInstance.current) {
      const id = setTimeout(() => rfInstance.current.fitView(fitOpts), 50);
      return () => clearTimeout(id);
    }
  }, [graph.nodes.length, mode]);

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
        ref={containerRef}
        className={`w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 ${mode === "providers" ? "h-[320px] sm:h-[480px]" : "h-[420px] sm:h-[560px]"}`}
      >
        {graph.nodes.length === 0 || (mode === "providers" && providers.length === 0) ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            {emptyMessages[mode]}
          </div>
        ) : (
          <ReactFlow
            key={graphKey}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={fitOpts}
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

      {mode !== "providers" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" /> healthy account</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" /> cooling / has failures</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-danger" /> unavailable</span>
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
