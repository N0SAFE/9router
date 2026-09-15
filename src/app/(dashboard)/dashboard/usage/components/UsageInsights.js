"use client";

import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import { cn } from "@/shared/utils/cn";
import TokenFlowBar from "./TokenFlowBar";
import { fmt, fmtCompact, fmtCost, fmtPct, fmtTime } from "./format";

const SEVERITY_VARIANT = { high: "error", medium: "warning", low: "info" };
const SEVERITY_ICON = { high: "error", medium: "warning", low: "lightbulb" };

function wasteVariant(score) {
  if (score >= 60) return "error";
  if (score >= 30) return "warning";
  return "success";
}

function StatTile({ icon, label, value, sub, accent }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-border-subtle bg-bg p-4">
      <div className="flex items-center gap-2 text-text-muted">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
        <span className="truncate text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className={cn("mt-2 font-mono text-xl font-semibold tabular-nums", accent || "text-text-main")}>{value}</p>
      {sub && <p className="mt-1 truncate text-xs text-text-muted">{sub}</p>}
    </div>
  );
}

function LoadingInsights() {
  return (
    <Card padding="md">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-[10px] bg-surface-2" />
        ))}
      </div>
    </Card>
  );
}

export default function UsageInsights({ insights, loading, providerName, onSelectOffender }) {
  if (loading && !insights) return <LoadingInsights />;
  if (!insights) return null;

  const o = insights.overview || {};
  const patterns = insights.patterns || [];
  const offenders = insights.offenders || [];
  const hasData = (o.requests || 0) > 0;
  const successRate = o.requests > 0 ? o.successes / o.requests : 0;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Token ledger — the signature panel */}
      <Card padding="md" className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-brand-500">savings</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Avoidable this window</span>
            </div>
            <div className="mt-2 flex items-end gap-3">
              <span className="font-mono text-4xl font-semibold leading-none tabular-nums text-brand-500">
                {fmtCompact(o.potentialSavingsTokens)}
              </span>
              <span className="pb-0.5 text-sm text-text-muted">tokens</span>
            </div>
            <p className="mt-2 text-sm text-text-muted">
              ≈ {fmtCost(o.potentialSavingsUsd)} of estimated spend. Fixes below are ranked by impact.
            </p>
            <TokenFlowBar
              className="mt-4"
              input={o.inputTokens}
              cached={o.cachedTokens}
              output={o.outputTokens}
              potential={o.potentialSavingsTokens}
              height="h-2.5"
              showLegend
            />
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <StatTile
              icon="bolt"
              label="Requests"
              value={fmt(o.requests)}
              sub={hasData ? `${fmtPct(successRate)} success · ${o.failures} failed` : "no traffic yet"}
            />
            <StatTile
              icon="login"
              label="Input"
              value={fmtCompact(o.inputTokens)}
              sub={`${fmtPct(o.cacheHitRate)} from cache`}
            />
            <StatTile
              icon="logout"
              label="Output"
              value={fmtCompact(o.outputTokens)}
              sub={o.reasoningTokens > 0 ? `${fmtCompact(o.reasoningTokens)} reasoning` : "no reasoning tokens"}
            />
            <StatTile
              icon="payments"
              label="Est. cost"
              value={fmtCost(o.totalCost)}
              sub={o.p95LatencyMs > 0 ? `p95 ${o.p95LatencyMs}ms` : "latency n/a"}
              accent="text-warning"
            />
          </div>
        </div>
      </Card>

      {/* Detected patterns */}
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-text-muted">travel_explore</span>
            <h3 className="font-semibold text-text-main">Token leaks detected</h3>
          </div>
          <Badge variant={patterns.length > 0 ? "warning" : "success"} size="sm" dot>
            {patterns.length > 0 ? `${patterns.length} pattern${patterns.length > 1 ? "s" : ""}` : "all clear"}
          </Badge>
        </div>

        {!hasData ? (
          <Card padding="md">
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <span className="material-symbols-outlined text-[32px] text-text-subtle">query_stats</span>
              <p className="text-sm text-text-main">No requests in this window yet.</p>
              <p className="max-w-md text-sm text-text-muted">
                Send some traffic, then come back. Insights need at least one completed request.
              </p>
            </div>
          </Card>
        ) : patterns.length === 0 ? (
          <Card padding="md" className="border-emerald-500/25">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[24px] text-emerald-500">verified</span>
              <div>
                <p className="text-sm font-medium text-text-main">No token leaks found in this window.</p>
                <p className="text-sm text-text-muted">
                  Keep Headroom and RTK enabled, and keep prompts cache-stable to stay here.
                </p>
              </div>
            </div>
          </Card>
        ) : (
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            {patterns.map((p) => (
              <Card key={p.id} padding="sm" className="min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn(
                      "material-symbols-outlined text-[20px]",
                      p.severity === "high" ? "text-danger" : p.severity === "medium" ? "text-warning" : "text-info"
                    )}>
                      {SEVERITY_ICON[p.severity] || "lightbulb"}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-main">{p.title}</p>
                      <p className="text-xs text-text-muted">
                        {p.occurrences} request{p.occurrences > 1 ? "s" : ""}
                        {p.wastedTokens > 0 ? ` · ~${fmtCompact(p.wastedTokens)} tokens` : ""}
                        {p.wastedUsd > 0 ? ` · ${fmtCost(p.wastedUsd)}` : ""}
                      </p>
                    </div>
                  </div>
                  <Badge variant={SEVERITY_VARIANT[p.severity] || "default"} size="sm">
                    {p.severity}
                  </Badge>
                </div>
                <p className="mt-3 text-sm text-text-muted">{p.explanation}</p>
                <div className="mt-3 flex items-start gap-2 rounded-[10px] bg-brand-500/5 p-3">
                  <span className="material-symbols-outlined text-[16px] text-brand-500">tips_and_updates</span>
                  <p className="text-xs leading-relaxed text-text-main">{p.tip}</p>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Biggest offenders */}
      {offenders.length > 0 && (
        <Card padding="none" className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-4">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-text-muted">local_fire_department</span>
              <h3 className="font-semibold text-text-main">Most wasteful requests</h3>
            </div>
            <span className="text-xs text-text-muted">ranked by avoidable tokens</span>
          </div>
          <ul className="divide-y divide-border-subtle">
            {offenders.map((row, index) => (
              <li key={`${row.id || index}`} className="flex flex-wrap items-center gap-3 p-4">
                <span className="w-6 font-mono text-sm text-text-subtle tabular-nums">{index + 1}</span>
                <div className="min-w-[180px] flex-1">
                  <p className="truncate font-mono text-sm text-text-main">{row.model || "unknown"}</p>
                  <p className="truncate text-xs text-text-muted">
                    {providerName ? providerName(row.provider) : row.provider} · {fmtTime(row.timestamp)}
                    {row.status !== "success" ? ` · ${row.status}` : ""}
                  </p>
                </div>
                <TokenFlowBar
                  className="hidden min-w-[160px] flex-1 sm:flex"
                  input={Math.max(0, (row.tokens?.prompt_tokens || row.tokens?.input_tokens || 0))}
                  cached={row.tokens?.cached_tokens || row.tokens?.cache_read_input_tokens || 0}
                  output={row.tokens?.completion_tokens || 0}
                  potential={row.wastedTokens}
                  height="h-1.5"
                />
                <div className="flex items-center gap-2">
                  <Badge variant={wasteVariant(row.wasteScore)} size="sm">
                    {row.wasteScore}% waste
                  </Badge>
                  <span className="font-mono text-xs text-text-muted tabular-nums">~{fmtCompact(row.wastedTokens)}</span>
                  <Button variant="ghost" size="sm" onClick={() => onSelectOffender?.(row)}>
                    Inspect
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
