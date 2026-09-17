"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import { cn } from "@/shared/utils/cn";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const MONTH_OPTIONS = [
  { value: 3, label: "3 months" },
  { value: 6, label: "6 months" },
  { value: 12, label: "12 months" },
];

const VERDICT_VARIANT = { healthy: "success", underused: "warning", idle: "error", unused: "neutral", inactive: "neutral" };
const VERDICT_ICON = { healthy: "check_circle", underused: "trending_down", idle: "block", unused: "help", inactive: "pause_circle" };

// Minimal **bold** renderer for the analyzer messages.
function RichText({ text, className }) {
  const parts = String(text || "").split("**");
  return (
    <p className={className}>
      {parts.map((part, index) =>
        index % 2 === 1 ? <strong key={index} className="font-semibold text-text-main">{part}</strong> : <span key={index}>{part}</span>
      )}
    </p>
  );
}

function fmt(n) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
}

function MonthDots({ row }) {
  return (
    <span className="inline-flex items-center gap-1" title={`${row.label}: ${row.requests} request(s)`}>
      <span
        className={cn(
          "size-2 rounded-full",
          row.requests > 0 ? "bg-emerald-500" : "border border-border bg-transparent",
          row.current && "ring-1 ring-primary/40"
        )}
      />
      <span className="text-[10px] text-text-subtle">{row.label}</span>
    </span>
  );
}

export default function SubscriptionOptimizer() {
  const [months, setMonths] = useState(3);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reportBusy, setReportBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { copy } = useCopyToClipboard();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/usage/subscriptions?months=${months}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to analyze subscriptions");
      setData(payload);
      setMessage("");
    } catch (error) {
      setMessage(String(error?.message || error));
    } finally {
      setLoading(false);
    }
  }, [months]);

  useEffect(() => {
    // Initial load; refresh() awaits its fetch before updating state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const copyReport = useCallback(async () => {
    setReportBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/usage/subscriptions?months=${months}&report=1`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to build the report");
      await copy(payload.report || "");
      setMessage("Report copied to the clipboard.");
    } catch (error) {
      setMessage(String(error?.message || error));
    } finally {
      setReportBusy(false);
    }
  }, [months, copy]);

  const summary = data?.summary;
  const providers = useMemo(() => data?.providers || [], [data]);
  const opportunities = useMemo(() => data?.recommendations || [], [data]);

  return (
    <Card padding="md" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-brand-500">subscriptions</span>
            <h2 className="text-lg font-semibold">Subscription optimizer</h2>
            {summary ? (
              <Badge variant={summary.flaggedConnections > 0 ? "warning" : "success"} size="sm" dot>
                {summary.flaggedConnections > 0
                  ? `${summary.flaggedConnections} connection${summary.flaggedConnections > 1 ? "s" : ""} not maxed`
                  : "all connections used"}
              </Badge>
            ) : null}
            {summary && summary.unusedConnections > 0 ? (
              <Badge variant="neutral" size="sm">
                {summary.unusedConnections} without traffic
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-text-muted">
            Checks plan-based connections against the traffic they actually carried: a paid seat that stayed idle while
            its siblings served the requests is flagged with what it cost you in unused capacity.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1">
            {MONTH_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMonths(option.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  months === option.value ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" icon="content_copy" loading={reportBusy} onClick={copyReport}>
            Copy report
          </Button>
          <Button variant="ghost" size="sm" icon="refresh" loading={loading} onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {message ? <p className="mt-2 text-xs text-text-muted">{message}</p> : null}

      {loading && !data ? (
        <div className="mt-3 flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-[10px] bg-surface-2" />
          ))}
        </div>
      ) : providers.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No plan-based connections found.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2.5">
          {providers.map((provider) => (
            <div key={provider.provider} className="min-w-0 rounded-[10px] border border-border-subtle bg-bg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text-main">{provider.providerLabel}</span>
                <span className="text-[11px] text-text-muted">
                  {provider.connections.length} connection{provider.connections.length > 1 ? "s" : ""} · {fmt(provider.totalRequests)} requests
                </span>
                {provider.hasTraffic === false ? (
                  <Badge variant="neutral" size="sm">no traffic</Badge>
                ) : provider.flagged > 0 ? (
                  <Badge variant="warning" size="sm">
                    {provider.flagged} not maxed
                  </Badge>
                ) : (
                  <Badge variant="success" size="sm">pulling weight</Badge>
                )}
              </div>

              <div className="mt-2 flex flex-col divide-y divide-border-subtle">
                {provider.connections.map((connection) => (
                  <div key={connection.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span
                      className={cn(
                        "material-symbols-outlined text-[16px]",
                        connection.verdict === "healthy" ? "text-emerald-500" : connection.verdict === "idle" ? "text-danger" : connection.verdict === "underused" ? "text-warning" : "text-text-subtle"
                      )}
                    >
                      {VERDICT_ICON[connection.verdict] || "help"}
                    </span>
                    <span className="min-w-[120px] font-mono text-xs text-text-main">{connection.name}</span>
                    <Badge variant={VERDICT_VARIANT[connection.verdict] || "default"} size="sm">
                      {connection.label}
                    </Badge>
                    <span className="text-[11px] text-text-muted">
                      {fmt(connection.requests)} req · {Math.round(connection.share * 100)}% of provider · {connection.idleDays} idle day{connection.idleDays === 1 ? "" : "s"}
                    </span>
                    <span className="ml-auto inline-flex items-center gap-2">
                      {connection.monthRows.map((row) => (
                        <MonthDots key={row.month} row={row} />
                      ))}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-2 flex flex-col gap-1 rounded-[10px] bg-surface-2/50 p-2.5">
                {provider.messages.map((text, index) => (
                  <RichText key={index} text={text} className="text-xs leading-relaxed text-text-muted" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {opportunities.length > 0 ? (
        <div className="mt-3 rounded-[10px] border border-warning/30 bg-warning/5 p-3">
          <p className="flex items-center gap-2 text-xs font-semibold text-text-main">
            <span className="material-symbols-outlined text-[16px] text-warning">savings</span>
            {opportunities.length} optimization opportunity{opportunities.length > 1 ? "ies" : "y"}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {opportunities.map((recommendation, index) => (
              <li key={index} className="text-xs leading-relaxed text-text-muted">
                <span className="font-semibold text-text-main">{recommendation.providerLabel}:</span> {recommendation.message.replace(/\*\*/g, "")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
