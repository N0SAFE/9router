"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { cn } from "@/shared/utils/cn";
import UsageFilterBar from "./UsageFilterBar";
import { useUsageFilters } from "./useUsageFilters";
import { fmtCompact, fmtCost } from "./format";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

const DIMENSIONS = [
  { value: "model", label: "Model" },
  { value: "provider", label: "Provider" },
  { value: "connection", label: "Connection" },
  { value: "apiKey", label: "API key" },
  { value: "endpoint", label: "Endpoint" },
];

const COLUMNS = [
  { id: "label", label: "Name", align: "left", get: (row) => row.label, format: (row) => row.label },
  { id: "requests", label: "Req", get: (row) => row.requests, format: (row) => fmtCompact(row.requests) },
  { id: "inputTokens", label: "In tok", get: (row) => row.inputTokens, format: (row) => fmtCompact(row.inputTokens) },
  { id: "outputTokens", label: "Out tok", get: (row) => row.outputTokens, format: (row) => fmtCompact(row.outputTokens) },
  { id: "cacheHitRate", label: "Cache", get: (row) => row.cacheHitRate ?? -1, format: (row) => (row.cacheHitRate === null ? "—" : `${Math.round(row.cacheHitRate * 100)}%`) },
  { id: "costUsd", label: "Cost", get: (row) => row.costUsd, format: (row) => fmtCost(row.costUsd) },
  { id: "costPer1kTokens", label: "$/1k", get: (row) => row.costPer1kTokens ?? -1, format: (row) => (row.costPer1kTokens === null ? "—" : `$${row.costPer1kTokens.toFixed(4)}`) },
  { id: "successRate", label: "OK", get: (row) => row.successRate ?? -1, format: (row) => (row.successRate === null ? "—" : `${Math.round(row.successRate * 100)}%`) },
  { id: "ttftAvg", label: "TTFT avg", get: (row) => row.ttftAvg ?? -1, format: (row) => (row.ttftAvg === null ? "—" : `${Math.round(row.ttftAvg)}ms`), title: "Average time to first token" },
  { id: "ttftP95", label: "TTFT p95", get: (row) => row.ttftP95 ?? -1, format: (row) => (row.ttftP95 === null ? "—" : `${Math.round(row.ttftP95)}ms`) },
  { id: "totalP50", label: "Total p50", get: (row) => row.totalP50 ?? -1, format: (row) => (row.totalP50 === null ? "—" : `${Math.round(row.totalP50)}ms`) },
  { id: "totalP95", label: "Total p95", get: (row) => row.totalP95 ?? -1, format: (row) => (row.totalP95 === null ? "—" : `${Math.round(row.totalP95)}ms`) },
  { id: "inputSpeedAvg", label: "In tok/s", get: (row) => row.inputSpeedAvg ?? -1, format: (row) => (row.inputSpeedAvg === null ? "—" : `${row.inputSpeedAvg.toFixed(1)}`), title: "Prompt tokens per second (prefill, from TTFT)" },
  { id: "outputSpeedAvg", label: "Out tok/s", get: (row) => row.outputSpeedAvg ?? -1, format: (row) => (row.outputSpeedAvg === null ? "—" : `${row.outputSpeedAvg.toFixed(1)}`), title: "Generated tokens per second (decode)" },
  { id: "outputSpeedP50", label: "Out p50", get: (row) => row.outputSpeedP50 ?? -1, format: (row) => (row.outputSpeedP50 === null ? "—" : `${row.outputSpeedP50.toFixed(1)}`) },
  { id: "outputSpeedP95", label: "Out p95", get: (row) => row.outputSpeedP95 ?? -1, format: (row) => (row.outputSpeedP95 === null ? "—" : `${row.outputSpeedP95.toFixed(1)}`) },
];

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fmtAxis(value) {
  if (typeof value !== "number") return "";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0);
}

export default function PerformanceTab() {
  const [period, setPeriod] = useState("7d");
  const { filters, queryString, patchFilters, clearFilters, activeCount } = useUsageFilters();
  const [dimension, setDimension] = useState("model");
  const [seriesKey, setSeriesKey] = useState(null);
  const [sort, setSort] = useState({ field: "requests", dir: "desc" });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period, dimension });
      if (seriesKey) params.set("key", seriesKey);
      if (queryString) {
        for (const [key, value] of new URLSearchParams(queryString)) params.set(key, value);
      }
      const response = await fetch(`/api/usage/performance?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to load performance metrics");
      setData(payload);
      setError("");
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [period, dimension, seriesKey, queryString]);

  useEffect(() => {
    // Initial load and refetch on period/dimension/filter changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    const items = data?.items || [];
    const sorted = [...items].sort((a, b) => {
      const column = COLUMNS.find((entry) => entry.id === sort.field) || COLUMNS[1];
      const left = column.get(a);
      const right = column.get(b);
      if (typeof left === "string" || typeof right === "string") {
        return sort.dir === "asc"
          ? String(left).localeCompare(String(right))
          : String(right).localeCompare(String(left));
      }
      return sort.dir === "asc" ? left - right : right - left;
    });
    return sorted.slice(0, 200);
  }, [data, sort]);

  const totals = useMemo(() => {
    const items = data?.items || [];
    const aggregate = items.reduce(
      (acc, row) => {
        acc.requests += row.requests;
        acc.inputTokens += row.inputTokens;
        acc.outputTokens += row.outputTokens;
        acc.costUsd += row.costUsd;
        acc.failures += row.failures;
        return acc;
      },
      { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failures: 0 }
    );
    return aggregate;
  }, [data]);

  const coverage = data?.latencyCoverage;
  const series = data?.series || [];
  const chartTitle = seriesKey ? `throughput · ${rows.find((row) => row.key === seriesKey)?.label || seriesKey}` : "throughput · all";

  const toggleSort = (field) => {
    setSort((current) => ({
      field,
      dir: current.field === field && current.dir === "desc" ? "asc" : "desc",
    }));
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Controls */}
      <Card padding="sm" className="sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} size="sm" />
          <SegmentedControl
            options={DIMENSIONS}
            value={dimension}
            onChange={(value) => {
              setDimension(value);
              setSeriesKey(null);
            }}
            size="sm"
          />
          <UsageFilterBar period={period} filters={filters} onPatch={patchFilters} onClear={clearFilters} />
          <div className="ml-auto flex items-center gap-2">
            {coverage ? (
              <span className="text-[11px] text-text-muted" title="Requests with latency data / total requests in this window">
                latency data: {fmtCompact(coverage.withLatency)}/{fmtCompact(coverage.total)} · ttft: {fmtCompact(coverage.withTtft)}
              </span>
            ) : null}
            {activeCount > 0 ? <Badge variant="primary" size="sm">{activeCount} filter{activeCount > 1 ? "s" : ""}</Badge> : null}
          </div>
        </div>
      </Card>

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {[
          { label: "Requests", value: fmtCompact(totals.requests), sub: totals.failures > 0 ? `${totals.failures} failed` : "all succeeded" },
          { label: "Input tokens", value: fmtCompact(totals.inputTokens) },
          { label: "Output tokens", value: fmtCompact(totals.outputTokens) },
          { label: "Cost", value: fmtCost(totals.costUsd) },
          {
            label: "Overall speed",
            value: data?.items?.length
              ? `${(data.items.reduce((sum, row) => sum + (row.outputSpeedAvg || 0) * row.requests, 0) / Math.max(1, data.items.reduce((sum, row) => sum + (row.outputSpeedAvg ? row.requests : 0), 0))).toFixed(1)} t/s`
              : "—",
            sub: "weighted output throughput",
          },
        ].map((tile) => (
          <Card key={tile.label} className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
            <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-text-muted">{tile.label}</span>
            <span className="truncate font-mono text-xl font-bold leading-tight text-text-main tabular-nums">{tile.value}</span>
            {tile.sub ? <span className="truncate text-[10px] text-text-subtle">{tile.sub}</span> : null}
          </Card>
        ))}
      </div>

      {/* Trend chart */}
      <Card padding="sm" className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-text-muted">speed</span>
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{chartTitle}</span>
          </div>
          {seriesKey ? (
            <button type="button" className="text-[11px] text-primary" onClick={() => setSeriesKey(null)}>
              show all
            </button>
          ) : (
            <span className="text-[11px] text-text-subtle">click a table row to focus the chart</span>
          )}
        </div>
        <div className="h-[220px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--color-text-muted)" />
              <YAxis yAxisId="speed" tickFormatter={fmtAxis} tick={{ fontSize: 10 }} stroke="var(--color-text-muted)" width={44} />
              <YAxis yAxisId="latency" orientation="right" tickFormatter={fmtAxis} tick={{ fontSize: 10 }} stroke="var(--color-text-muted)" width={44} />
              <ChartTooltip
                contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 11 }}
                formatter={(value, name) => [typeof value === "number" ? value.toFixed(1) : value, name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="speed" type="monotone" dataKey="outputSpeed" name="out tok/s" stroke="#22c55e" strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="speed" type="monotone" dataKey="inputSpeed" name="in tok/s" stroke="#38bdf8" strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="latency" type="monotone" dataKey="ttftAvg" name="TTFT ms" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Metrics table */}
      <Card padding="none" className="min-w-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-3.5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-text-muted">table_view</span>
            <h3 className="text-sm font-semibold text-text-main">Metrics by {DIMENSIONS.find((entry) => entry.value === dimension)?.label.toLowerCase()}</h3>
          </div>
          <span className="text-[11px] text-text-muted">
            {data?.items?.length ? `${data.items.length} row(s)` : ""} {loading ? "· loading…" : ""}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse">
            <thead>
              <tr className="border-b border-border-subtle bg-bg/60 text-left text-[11px] uppercase tracking-wide text-text-muted">
                {COLUMNS.map((column) => (
                  <th
                    key={column.id}
                    title={column.title || undefined}
                    onClick={() => toggleSort(column.id)}
                    className={cn(
                      "cursor-pointer select-none whitespace-nowrap px-3 py-2 font-semibold transition-colors hover:text-text-main",
                      column.align === "left" ? "text-left" : "text-right",
                      sort.field === column.id && "text-text-main"
                    )}
                  >
                    {column.label}
                    {sort.field === column.id ? <span className="ml-1">{sort.dir === "desc" ? "▾" : "▴"}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {loading && !data ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="p-8 text-center text-text-muted">
                    <span className="material-symbols-outlined animate-spin text-[18px] align-middle">progress_activity</span>
                    <span className="ml-2 align-middle">Loading metrics…</span>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="p-8 text-center text-text-muted">
                    No requests in this window.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.key}
                    onClick={() => setSeriesKey((current) => (current === row.key ? null : row.key))}
                    className={cn(
                      "cursor-pointer text-xs transition-colors hover:bg-surface-2/50",
                      seriesKey === row.key && "bg-primary/5"
                    )}
                  >
                    {COLUMNS.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          "whitespace-nowrap px-3 py-2 tabular-nums",
                          column.id === "label" ? "max-w-[280px] truncate font-mono text-text-main" : "text-right text-text-muted"
                        )}
                        title={column.id === "label" ? row.label : undefined}
                      >
                        {column.format(row)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border-subtle p-2.5 text-[11px] text-text-muted">
          In tok/s = prompt tokens ÷ TTFT (prefill, approximate). Out tok/s = generated tokens ÷ (total − TTFT), falling back to the
          full latency when TTFT is unknown. Rows with “—” have no latency samples yet in this window.
        </div>
      </Card>
    </div>
  );
}
