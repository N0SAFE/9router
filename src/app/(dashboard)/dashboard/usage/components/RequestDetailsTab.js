"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import Badge from "@/shared/components/Badge";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { cn } from "@/shared/utils/cn";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import {
  analyzeRequest,
  PATTERN_META,
  getInputTokens,
  getCachedTokens,
  getCacheCreationTokens,
  getOutputTokens,
} from "@/lib/usage/insights";
import TokenFlowBar from "./TokenFlowBar";
import UsageInsights from "./UsageInsights";
import UsageFilterBar from "./UsageFilterBar";
import { useUsageFilters } from "./useUsageFilters";
import { fmt, fmtCompact, fmtCost, fmtPct, fmtTime, fmtDateTime, fmtDuration } from "./format";

const PERIODS = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

const PERIOD_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function periodStart(period) {
  if (!period || period === "all") return undefined;
  const ms = PERIOD_MS[period];
  return new Date(Date.now() - ms).toISOString();
}

function wasteVariant(score) {
  if (score >= 60) return "error";
  if (score >= 30) return "warning";
  if (score > 0) return "info";
  return "success";
}

let providerNameCache = null;

async function fetchProviderNames() {
  if (providerNameCache) return providerNameCache;
  const nodesRes = await fetch("/api/provider-nodes");
  const nodesData = await nodesRes.json();
  const nodes = nodesData.nodes || [];
  const nodeNames = {};
  for (const node of nodes) nodeNames[node.id] = node.name;
  providerNameCache = { ...AI_PROVIDERS, ...nodeNames };
  return providerNameCache;
}

function getProviderName(providerId, cache) {
  if (!providerId) return "—";
  const cached = cache?.[providerId];
  if (typeof cached === "string") return cached;
  if (cached?.name) return cached.name;
  const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
  return providerConfig?.name || providerId;
}

function StatusPill({ status }) {
  const ok = !status || status === "success";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger")}>
      <span className={cn("size-1.5 rounded-full", ok ? "bg-emerald-500" : "bg-danger")} />
      {ok ? "success" : status}
    </span>
  );
}

function routeLabel(detail) {
  const routing = detail?.routing;
  if (routing?.combo?.name) return { kind: "combo", label: routing.combo.name, models: routing.combo.models?.length || 0 };
  if (routing?.provider || routing?.pool) {
    const redirects = routing.attempts?.length || 0;
    return { kind: "pool", label: routing.provider || routing.pool?.provider || "pool", redirects };
  }
  if (detail?.routingSummary) return { kind: "summary", label: detail.routingSummary.split(" | ")[0], redirects: 0 };
  return null;
}

function actionVariant(action) {
  if (action === "capability") return "warning";
  if (action === "fallback") return "error";
  if (action === "non-fallback") return "default";
  return "info";
}

function RoutingTimeline({ detail }) {
  const routing = detail?.routing;
  if (!routing) {
    return detail?.routingSummary ? (
      <div className="rounded-[10px] border border-border-subtle bg-bg p-3 font-mono text-[11px] text-text-muted">
        {detail.routingSummary}
      </div>
    ) : (
      <p className="text-xs text-text-muted">
        No routing trace stored for this request (captured before tracing was enabled, or recovered from usage history).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="default" size="sm">requested</Badge>
        <span className="font-mono text-text-main">{routing.requestedModel || "—"}</span>
        <span className="material-symbols-outlined text-[14px] text-text-muted">arrow_forward</span>
        <Badge variant="primary" size="sm">{routing.provider || "—"}</Badge>
        <span className="font-mono text-text-main">{routing.model || "—"}</span>
        {routing.combo && (
          <Badge variant="info" size="sm">
            {routing.combo.kind === "capacity" ? "capacity adapter" : "combo"}: {routing.combo.name} · {routing.combo.strategy}
          </Badge>
        )}
      </div>

      {routing.combo?.models?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {routing.combo.models.map((model) => (
            <span
              key={model.model}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px]",
                model.status === "success"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-surface-2 text-text-muted"
              )}
              title={model.error || undefined}
            >
              <span className="material-symbols-outlined text-[12px]">{model.status === "success" ? "check" : "close"}</span>
              {model.model}
            </span>
          ))}
        </div>
      )}

      {routing.selected && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="success" size="sm">selected</Badge>
          <span className="font-mono text-text-main">{routing.selected.name || routing.selected.connectionId || "—"}</span>
          {routing.selected.reason && <span className="text-text-muted">({routing.selected.reason})</span>}
        </div>
      )}

      {routing.attempts?.length > 0 && (
        <ol className="space-y-1.5">
          {routing.attempts.map((attempt, index) => (
            <li key={`${attempt.connectionId || "a"}-${index}`} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border-subtle bg-bg p-2.5 text-xs">
              <span className="font-mono text-text-subtle">{index + 1}</span>
              <span className="font-mono text-text-main">{attempt.name || attempt.connectionId || "account"}</span>
              <Badge variant={actionVariant(attempt.action)} size="sm">{attempt.action || "failed"}</Badge>
              <span className="font-mono text-text-muted">status {attempt.status ?? "?"}</span>
              {attempt.cooldownMs > 0 && (
                <span className="text-text-muted">cooldown {Math.round(attempt.cooldownMs / 1000)}s</span>
              )}
              {attempt.redirectTo && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <span className="material-symbols-outlined text-[13px]">alt_route</span>
                  → {attempt.redirectTo.slice(0, 8)}
                </span>
              )}
              {attempt.error && (
                <span className="w-full truncate text-[11px] text-text-subtle" title={attempt.error}>{attempt.error}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function InsightHintList({ flags }) {
  if (!flags || flags.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-emerald-500/20 bg-emerald-500/5 p-3">
        <span className="material-symbols-outlined text-[18px] text-emerald-500">verified</span>
        <p className="text-sm text-text-main">No token leaks detected on this request.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {flags.map((flag) => {
        const meta = PATTERN_META[flag.id] || { title: flag.id, explanation: "", tip: "" };
        return (
          <div key={flag.id} className="rounded-[10px] border border-border-subtle bg-bg p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-text-main">{meta.title}</span>
              {flag.wastedTokens > 0 && (
                <Badge variant="warning" size="sm">~{fmt(flag.wastedTokens)} tokens</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-text-muted">{meta.explanation}</p>
            <div className="mt-2 flex items-start gap-2">
              <span className="material-symbols-outlined text-[15px] text-brand-500">tips_and_updates</span>
              <p className="text-xs leading-relaxed text-text-main">{meta.tip}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const ROLE_VARIANT = {
  user: "info",
  assistant: "success",
  system: "default",
  developer: "primary",
  tool: "warning",
  function: "warning",
};

function ContentDigestView({ digest }) {
  if (!digest) return null;
  const tools = digest.tools || [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default" size="sm">{digest.messageCount} messages</Badge>
        {tools.length > 0 && <Badge variant="default" size="sm">{tools.length} tools</Badge>}
        {digest.truncated && (
          <Badge variant="warning" size="sm">
            truncated{digest.originalBytes ? ` from ${fmtCompact(digest.originalBytes)}B` : ""}
          </Badge>
        )}
      </div>

      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tools.slice(0, 16).map((name) => (
            <span key={name} className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-muted">{name}</span>
          ))}
          {tools.length > 16 && <span className="text-[11px] text-text-subtle">+{tools.length - 16} more</span>}
        </div>
      )}

      {digest.truncated && digest.truncatedPreview && (
        <p className="rounded-[10px] bg-bg p-2 font-mono text-[11px] leading-relaxed text-text-muted">{digest.truncatedPreview}</p>
      )}

      {digest.messages?.length > 0 && (
        <div className="space-y-1.5">
          {digest.messages.map((message, index) => (
            <div key={index} className="rounded-[10px] border border-border-subtle bg-bg p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={ROLE_VARIANT[message.role] || "default"} size="sm">{message.role}</Badge>
                <span className="text-[11px] text-text-muted">{fmt(message.chars)} chars</span>
                {message.toolCalls && (
                  <span className="truncate font-mono text-[11px] text-text-subtle">→ {message.toolCalls.join(", ")}</span>
                )}
              </div>
              {message.preview && (
                <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-main">{message.preview}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {digest.response && (
        <div className="rounded-[10px] border border-border-subtle bg-bg p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success" size="sm">response</Badge>
            <span className="text-[11px] text-text-muted">
              {fmt(digest.response.contentChars)} chars{digest.response.finishReason ? ` · ${digest.response.finishReason}` : ""}
            </span>
          </div>
          {digest.response.preview && (
            <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-main">{digest.response.preview}</p>
          )}
          {digest.response.thinkingChars > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-text-muted">
                thinking ({fmt(digest.response.thinkingChars)} chars)
              </summary>
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">{digest.response.thinkingPreview}</p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false, icon = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-[10px] border border-border-subtle">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between bg-bg p-3 transition-colors hover:bg-surface-2/60"
      >
        <div className="flex items-center gap-2">
          {icon && <span className="material-symbols-outlined text-[18px] text-text-muted">{icon}</span>}
          <span className="text-sm font-semibold text-text-main">{title}</span>
        </div>
        <span className={cn("material-symbols-outlined text-[20px] text-text-muted transition-transform duration-200", isOpen && "rotate-90")}>
          chevron_right
        </span>
      </button>
      {isOpen && <div className="border-t border-border-subtle p-4">{children}</div>}
    </div>
  );
}

export default function RequestDetailsTab() {
  const searchParams = useSearchParams();
  const { filters, queryString, patchFilters, clearFilters, activeCount } = useUsageFilters();
  const [period, setPeriod] = useState(() => {
    const urlPeriod = searchParams.get("period");
    return PERIODS.some((p) => p.value === urlPeriod) ? urlPeriod : "7d";
  });
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [insights, setInsights] = useState(null);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [providerNameCache, setProviderNameCache] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const startDate = useMemo(() => periodStart(period), [period]);
  const providerName = useCallback((id) => getProviderName(id, providerNameCache), [providerNameCache]);
  const connectionName = useCallback((row) => {
    if (!row?.connectionId) return "—";
    return row.connectionName || row.connectionId.slice(0, 8);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchProviderNames()
      .then((cache) => { if (!cancelled) setProviderNameCache(cache); })
      .catch((error) => console.error("Failed to fetch provider names:", error));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ period });
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.append(key, value);
    }
    fetch(`/api/usage/insights?${params}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => { if (!cancelled && data && !data.error) setInsights(data); })
      .catch((error) => console.error("Failed to fetch usage insights:", error))
      .finally(() => { if (!cancelled) setInsightsLoading(false); });
    return () => { cancelled = true; };
  }, [period, filters, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      page: String(pagination.page),
      pageSize: String(pagination.pageSize),
    });
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.append(key, value);
    }
    if (startDate) params.append("startDate", startDate);
    fetch(`/api/usage/request-details?${params}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setDetails(data.details || []);
        setPagination((prev) => ({ ...prev, ...data.pagination }));
      })
      .catch((error) => console.error("Failed to fetch request details:", error))
      .finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
  }, [pagination.page, pagination.pageSize, filters, startDate, refreshKey]);

  const handleRefresh = () => {
    setRefreshing(true);
    setInsightsLoading(true);
    setDetailsLoading(true);
    setRefreshKey((k) => k + 1);
    setTimeout(() => setRefreshing(false), 800);
  };

  const handlePeriodChange = (value) => {
    setPeriod(value);
    setInsightsLoading(true);
    setDetailsLoading(true);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handleFilterPatch = useCallback(
    (patch) => {
      setInsightsLoading(true);
      setDetailsLoading(true);
      setPagination((prev) => ({ ...prev, page: 1 }));
      patchFilters(patch);
    },
    [patchFilters]
  );

  const handleFilterClear = useCallback(() => {
    setInsightsLoading(true);
    setDetailsLoading(true);
    setPagination((prev) => ({ ...prev, page: 1 }));
    clearFilters();
  }, [clearFilters]);

  const handlePageChange = (newPage) => {
    setDetailsLoading(true);
    setPagination((prev) => ({ ...prev, page: newPage }));
  };

  const handlePageSizeChange = (newPageSize) => {
    setDetailsLoading(true);
    setPagination((prev) => ({ ...prev, pageSize: newPageSize, page: 1 }));
  };

  const openDetail = (detail) => {
    setSelectedDetail(detail);
    setDrawerOpen(true);
  };

  const selectedAnalysis = useMemo(
    () => (selectedDetail ? analyzeRequest(selectedDetail, { costEstimator: (r) => r.cost }) : null),
    [selectedDetail]
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Filters */}
      <Card padding="sm" className="sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl options={PERIODS} value={period} onChange={handlePeriodChange} size="sm" />
          <UsageFilterBar period={period} filters={filters} onPatch={handleFilterPatch} onClear={handleFilterClear} />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-text-muted">
              {insights?.sampled ? `${fmt(insights.sampled)} sampled` : ""}
              {activeCount > 0 ? ` · ${activeCount} filter${activeCount > 1 ? "s" : ""}` : ""}
            </span>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
              <span className={cn("material-symbols-outlined text-[16px]", refreshing && "animate-spin")}>refresh</span>
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {/* Insights */}
      <UsageInsights
        insights={insights}
        loading={insightsLoading}
        providerName={providerName}
        onSelectOffender={openDetail}
        period={period}
        filters={filters}
      />

      {/* Requests table */}
      <Card padding="none" className="min-w-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-text-muted">receipt_long</span>
            <h3 className="font-semibold text-text-main">Requests</h3>
          </div>
          <span className="text-xs text-text-muted">click a row for the full breakdown</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px]">
            <thead>
              <tr className="border-b border-border-subtle bg-bg/60 text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="p-4 font-semibold">Time</th>
                <th className="p-4 font-semibold">Model</th>
                <th className="p-4 font-semibold">Connection</th>
                <th className="p-4 font-semibold">Route</th>
                <th className="p-4 font-semibold">Token flow</th>
                <th className="p-4 text-right font-semibold">Tokens</th>
                <th className="p-4 text-right font-semibold">Cost</th>
                <th className="p-4 font-semibold">Latency</th>
                <th className="p-4 text-center font-semibold">Waste</th>
                <th className="p-4 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {detailsLoading ? (
                <tr>
                  <td colSpan={10} className="p-10 text-center text-text-muted">
                    <span className="material-symbols-outlined animate-spin text-[20px] align-middle">progress_activity</span>
                    <span className="ml-2 align-middle">Loading requests…</span>
                  </td>
                </tr>
              ) : details.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-10 text-center text-text-muted">
                    No requests in this window.
                  </td>
                </tr>
              ) : (
                details.map((detail, index) => {
                  const analysis = analyzeRequest(detail, { costEstimator: (r) => r.cost });
                  const input = getInputTokens(detail.tokens);
                  const cached = getCachedTokens(detail.tokens);
                  const output = getOutputTokens(detail.tokens);
                  return (
                    <tr
                      key={`${detail.id}-${index}`}
                      onClick={() => openDetail(detail)}
                      className="group cursor-pointer transition-colors hover:bg-surface-2/50"
                    >
                      <td className="whitespace-nowrap p-4 text-sm text-text-muted">{fmtTime(detail.timestamp)}</td>
                      <td className="max-w-[240px] p-4">
                        <p className="truncate font-mono text-sm text-text-main">{detail.model || "unknown"}</p>
                        <p className="flex items-center gap-1.5 truncate text-xs text-text-muted">
                          {providerName(detail.provider)}
                          {detail.source === "history" && (
                            <span className="rounded bg-surface-2 px-1 text-[10px] uppercase tracking-wide text-text-subtle">history</span>
                          )}
                        </p>
                      </td>
                      <td className="max-w-[180px] p-4">
                        {detail.connectionId ? (
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); handleFilterPatch({ connectionId: detail.connectionId }); }}
                            className="flex max-w-full items-center gap-1.5 truncate rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-main hover:bg-surface-3"
                            title={detail.connectionName || detail.connectionId}
                          >
                            <span className="material-symbols-outlined text-[14px] text-text-muted">account_circle</span>
                            <span className="truncate">{connectionName(detail)}</span>
                          </button>
                        ) : (
                          <span className="text-xs text-text-subtle">—</span>
                        )}
                      </td>
                      <td className="max-w-[190px] p-4">
                        {(() => {
                          const route = routeLabel(detail);
                          if (!route) return <span className="text-xs text-text-subtle">—</span>;
                          return (
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <Badge variant={route.kind === "combo" ? "primary" : route.kind === "pool" ? "info" : "default"} size="sm">
                                  {route.kind === "combo" ? "combo" : route.kind === "pool" ? "pool" : "route"}
                                </Badge>
                                <span className="truncate font-mono text-[11px] text-text-muted">{route.label}</span>
                              </span>
                              {route.redirects > 0 && (
                                <span className="flex items-center gap-1 text-[11px] text-warning">
                                  <span className="material-symbols-outlined text-[13px]">alt_route</span>
                                  {route.redirects} redirect{route.redirects > 1 ? "s" : ""}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="min-w-[180px] p-4">
                        <TokenFlowBar input={input} cached={cached} output={output} potential={analysis.wastedTokens} height="h-1.5" />
                      </td>
                      <td className="p-4 text-right font-mono text-sm text-text-main tabular-nums">
                        {fmtCompact(analysis.total)}
                        {cached > 0 && <span className="block text-[11px] text-emerald-600 dark:text-emerald-400">{fmtPct(input > 0 ? cached / input : 0)} cached</span>}
                      </td>
                      <td className="p-4 text-right font-mono text-sm text-text-main tabular-nums">{fmtCost(detail.cost)}</td>
                      <td className="whitespace-nowrap p-4 text-xs text-text-muted">
                        {detail.latency?.total ? (
                          <>
                            <span className="font-mono tabular-nums">{fmtDuration(detail.latency?.ttft)}</span> TTFT
                            <span className="block font-mono tabular-nums">{fmtDuration(detail.latency?.total)} total</span>
                          </>
                        ) : (
                          <span className="text-text-subtle">—</span>
                        )}
                      </td>
                      <td className="p-4 text-center">
                        {analysis.wastedTokens > 0 ? (
                          <Badge variant={wasteVariant(analysis.wasteScore)} size="sm">{analysis.wasteScore}%</Badge>
                        ) : (
                          <span className="text-xs text-text-subtle">—</span>
                        )}
                      </td>
                      <td className="p-4"><StatusPill status={detail.status} /></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!detailsLoading && details.length > 0 && (
          <div className="border-t border-border-subtle">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </Card>

      {/* Detail drawer */}
      <Drawer isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} title="Request breakdown" width="lg">
        {selectedDetail && selectedAnalysis && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-text-main">{selectedDetail.model || "unknown"}</span>
              <Badge variant="default" size="sm">{providerName(selectedDetail.provider)}</Badge>
              <StatusPill status={selectedDetail.status} />
              <span className="ml-auto text-xs text-text-muted">{fmtDateTime(selectedDetail.timestamp)}</span>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-text-muted">route</span>
                <h4 className="text-sm font-semibold text-text-main">Routing</h4>
              </div>
              <RoutingTimeline detail={selectedDetail} />
            </div>

            <TokenFlowBar
              input={selectedAnalysis.input}
              cached={selectedAnalysis.cached}
              output={selectedAnalysis.output}
              potential={selectedAnalysis.wastedTokens}
              height="h-3"
              showLegend
            />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Input", value: fmt(selectedAnalysis.input) },
                { label: "Cached", value: fmt(selectedAnalysis.cached), sub: fmtPct(selectedAnalysis.input > 0 ? selectedAnalysis.cached / selectedAnalysis.input : 0) },
                { label: "Cache write", value: fmt(getCacheCreationTokens(selectedDetail.tokens)) },
                { label: "Output", value: fmt(selectedAnalysis.output) },
                { label: "Reasoning", value: fmt(selectedAnalysis.reasoning) },
                { label: "Total", value: fmt(selectedAnalysis.total) },
                { label: "Est. cost", value: fmtCost(selectedDetail.cost), accent: "text-warning" },
                {
                  label: "Latency",
                  value: selectedDetail.latency?.total
                    ? `${fmtDuration(selectedDetail.latency?.ttft)} / ${fmtDuration(selectedDetail.latency?.total)}`
                    : "—",
                },
              ].map((item) => (
                <div key={item.label} className="rounded-[10px] border border-border-subtle bg-bg p-3">
                  <p className="text-[11px] uppercase tracking-wide text-text-muted">{item.label}</p>
                  <p className={cn("mt-1 font-mono text-sm font-semibold tabular-nums", item.accent || "text-text-main")}>{item.value}</p>
                  {item.sub && <p className="text-[11px] text-text-muted">{item.sub}</p>}
                </div>
              ))}
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-text-muted">lightbulb</span>
                <h4 className="text-sm font-semibold text-text-main">How to spend less on this request</h4>
                {selectedAnalysis.wastedTokens > 0 && (
                  <Badge variant={wasteVariant(selectedAnalysis.wasteScore)} size="sm">
                    ~{fmt(selectedAnalysis.wastedTokens)} avoidable
                  </Badge>
                )}
              </div>
              <InsightHintList flags={selectedAnalysis.flags} />
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-text-muted">compress</span>
                <h4 className="text-sm font-semibold text-text-main">Request content (compressed)</h4>
              </div>
              {selectedDetail.contentDigest ? (
                <ContentDigestView digest={selectedDetail.contentDigest} />
              ) : (
                <p className="text-xs text-text-muted">
                  No content preview stored for this request
                  {selectedDetail.source === "history" ? " — it was recovered from usage history, which only keeps token counts." : "."}
                </p>
              )}
            </div>

            {selectedDetail.pxpipe && (
              <div className="rounded-[10px] border border-border-subtle p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-text-muted">image</span>
                  <span className="text-sm font-semibold text-text-main">PXPIPE</span>
                  <Badge variant={selectedDetail.pxpipe.applied ? "success" : "warning"} size="sm">
                    {selectedDetail.pxpipe.applied ? "Activated" : "Skipped"}
                  </Badge>
                </div>
                {selectedDetail.pxpipe.applied ? (
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div><span className="block text-xs text-text-muted">Before (est.)</span><span className="font-mono">{(selectedDetail.pxpipe.tokensBeforeEst || 0).toLocaleString()}</span></div>
                    <div><span className="block text-xs text-text-muted">After (est.)</span><span className="font-mono">{(selectedDetail.pxpipe.tokensAfterEst || 0).toLocaleString()}</span></div>
                    <div><span className="block text-xs text-text-muted">Saved</span><span className="font-mono text-emerald-600">{selectedDetail.pxpipe.savedPct || 0}%</span></div>
                    <div><span className="block text-xs text-text-muted">Images</span><span className="font-mono">{selectedDetail.pxpipe.imageCount || 0} ({selectedDetail.pxpipe.durationMs || 0}ms)</span></div>
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">Reason: <span className="font-mono">{selectedDetail.pxpipe.reason}</span></p>
                )}
              </div>
            )}

            <div className="space-y-3">
              <p className="text-xs text-text-muted">
                Payload bodies are hidden by the API for privacy; token, latency and cost metadata is shown above.
              </p>
              <CollapsibleSection title="Raw record" icon="data_object">
                <pre className="max-h-[320px] overflow-auto rounded-[10px] bg-bg p-3 font-mono text-xs text-text-main">
                  {JSON.stringify(selectedDetail, null, 2)}
                </pre>
              </CollapsibleSection>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
