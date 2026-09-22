"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { cn } from "@/shared/utils/cn";
import { fmtCompact, fmtCost, fmtDuration } from "./format";

const VIEWS = [
  { value: "timeline", label: "Timeline" },
  { value: "chat", label: "Chat" },
];

function costTone(turn, maxCost) {
  if (!turn.costUsd || !maxCost) return "bg-emerald-500/70";
  const ratio = turn.costUsd / maxCost;
  if (ratio >= 0.75) return "bg-red-500/80";
  if (ratio >= 0.4) return "bg-amber-500/80";
  return "bg-emerald-500/70";
}

function flushName(turn) {
  const stamp = turn.timestamp ? new Date(turn.timestamp) : null;
  return stamp ? stamp.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

function TurnBadges({ turn }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-muted">
      <span className="text-primary">↑{fmtCompact(turn.tokens.input)}</span>
      {turn.tokens.cached > 0 ? <span className="text-sky-500">⚡{fmtCompact(turn.tokens.cached)}</span> : null}
      <span className="text-emerald-600 dark:text-emerald-400">↓{fmtCompact(turn.tokens.output)}</span>
      {turn.tokens.reasoning > 0 ? <span>{fmtCompact(turn.tokens.reasoning)} think</span> : null}
      <span className={cn(turn.costUsd >= 0.05 ? "text-warning" : "")}>{fmtCost(turn.costUsd)}</span>
      {turn.total ? <span>{fmtDuration(turn.total)}</span> : null}
      {turn.outputSpeed ? <span>{turn.outputSpeed.toFixed(1)} tok/s</span> : null}
      {turn.toolCalls?.length ? <span className="text-brand-500">{turn.toolCalls.length} tool{turn.toolCalls.length > 1 ? "s" : ""}</span> : null}
    </span>
  );
}

function SpikeIcon({ flags }) {
  if (!flags?.length) return null;
  return (
    <span
      className="material-symbols-outlined text-[15px] text-warning"
      title={flags.map((flag) => flag.message).join("\n")}
    >
      local_fire_department
    </span>
  );
}

export default function SessionsTab() {
  const [sessions, setSessions] = useState([]);
  const [counts, setCounts] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);
  const [view, setView] = useState("timeline");
  const [live, setLive] = useState(true);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedTurn, setExpandedTurn] = useState(null);
  const [budgetDraft, setBudgetDraft] = useState({ cost: "", tokens: "" });
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [follow, setFollow] = useState(true);
  const bottomRef = useRef(null);
  const eventSourceRef = useRef(null);

  const refreshList = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "80" });
      if (query.trim()) params.set("q", query.trim());
      const response = await fetch(`/api/usage/sessions?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to load sessions");
      setSessions(payload.sessions || []);
      setCounts(payload.counts || null);
      setError("");
      setSelectedId((current) => current || payload.sessions?.[0]?.id || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    // Initial load + refresh when the search changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshList();
    const timer = setInterval(refreshList, 15000);
    return () => clearInterval(timer);
  }, [refreshList]);
  // Streamed session detail (SSE) — snapshot then live updates.
  useEffect(() => {
    if (!selectedId) return undefined;
    // Reset the view when switching sessions.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(null);
    setExpandedTurn(null);
    setBudgetDraft({ cost: "", tokens: "" });

    if (!live) {
      let cancelled = false;
      fetch(`/api/usage/sessions/${encodeURIComponent(selectedId)}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => {
          if (!cancelled) setSession(payload);
        })
        .catch((err) => !cancelled && setError(String(err?.message || err)));
      return () => {
        cancelled = true;
      };
    }

    const source = new EventSource(`/api/usage/sessions/${encodeURIComponent(selectedId)}/stream`);
    eventSourceRef.current = source;
    source.addEventListener("snapshot", (event) => {
      try {
        setSession(JSON.parse(event.data));
      } catch {
        // ignore malformed frame
      }
    });
    source.addEventListener("update", (event) => {
      try {
        setSession(JSON.parse(event.data));
      } catch {
        // ignore malformed frame
      }
    });
    source.onerror = () => {
      // The browser retries automatically; keep the last snapshot meanwhile.
    };
    return () => {
      source.close();
      eventSourceRef.current = null;
    };
  }, [selectedId, live]);

  useEffect(() => {
    if (follow && bottomRef.current) {
      bottomRef.current.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [session, follow, view]);

  const turns = useMemo(() => session?.turns || [], [session]);
  const maxTotal = useMemo(() => Math.max(1, ...turns.map((turn) => turn.total || 0)), [turns]);
  const maxCost = useMemo(() => Math.max(0, ...turns.map((turn) => turn.costUsd || 0)), [turns]);
  const chartData = useMemo(
    () =>
      turns.map((turn, index) => ({
        label: `#${index + 1}`,
        cost: Number(turn.cumulativeCostUsd?.toFixed(4) || 0),
        tokens: turn.cumulativeTokens || 0,
        turnCost: Number((turn.costUsd || 0).toFixed(4)),
      })),
    [turns]
  );
  const spikeIds = useMemo(() => new Set((session?.spikes?.flagged || []).map((entry) => entry.turnId)), [session]);

  const saveMonitor = useCallback(
    async (patch) => {
      if (!selectedId) return;
      setBudgetSaving(true);
      try {
        const response = await fetch("/api/usage/sessions/monitor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: selectedId,
            label: session?.summary?.label || null,
            ...patch,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to update monitor");
        await refreshList();
      } catch (err) {
        setError(String(err?.message || err));
      } finally {
        setBudgetSaving(false);
      }
    },
    [selectedId, session, refreshList]
  );

  const removeMonitor = useCallback(async () => {
    if (!selectedId) return;
    await fetch(`/api/usage/sessions/monitor?sessionId=${encodeURIComponent(selectedId)}`, { method: "DELETE" }).catch(() => {});
    await refreshList();
  }, [selectedId, refreshList]);

  const selectedSummary = session?.summary || null;
  const budget = session?.budget || null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
        {/* Session list */}
        <Card padding="sm" className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-text-muted">forum</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Sessions</span>
            </div>
            {counts ? (
              <span className="text-[10px] text-text-subtle">
                {counts.live} live · {counts.monitored} watched
              </span>
            ) : null}
          </div>

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions…"
            className="h-8 w-full rounded-lg border border-border bg-surface px-2 text-xs text-text-main placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-primary/20"
          />

          <div className="flex max-h-[560px] flex-col divide-y divide-border-subtle overflow-y-auto">
            {loading && sessions.length === 0 ? (
              <div className="p-6 text-center text-xs text-text-muted">
                <span className="material-symbols-outlined animate-spin text-[16px] align-middle">progress_activity</span>
                <span className="ml-2 align-middle">Loading sessions…</span>
              </div>
            ) : sessions.length === 0 ? (
              <p className="p-4 text-xs text-text-muted">No sessions recorded yet. Start a chat and enable Monitor.</p>
            ) : (
              sessions.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  className={cn(
                    "flex flex-col gap-0.5 px-2 py-2 text-left transition-colors hover:bg-surface-2/60",
                    selectedId === entry.id && "bg-primary/5"
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    {entry.live ? <span className="size-1.5 rounded-full bg-emerald-500" title="live" /> : null}
                    {entry.monitored ? <span className="material-symbols-outlined text-[13px] text-brand-500">visibility</span> : null}
                    {entry.budgetExceeded ? <span className="material-symbols-outlined text-[13px] text-danger">battery_alert</span> : null}
                    <span className="truncate text-xs font-medium text-text-main">{entry.label || entry.id}</span>
                  </span>
                  <span className="flex items-center gap-2 pl-0.5 text-[10px] text-text-muted">
                    <span className="truncate">{entry.model || "—"}</span>
                    <span>{entry.requests} req</span>
                    <span>{fmtCompact(entry.tokens)} tok</span>
                    <span>{fmtCost(entry.costUsd)}</span>
                    <span className="ml-auto">{fmtTimeAgo(entry.lastAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </Card>

        {/* Session detail */}
        <Card padding="sm" className="flex min-w-0 flex-col gap-3">
          {!session ? (
            <div className="flex h-[320px] items-center justify-center text-sm text-text-muted">
              {selectedId ? "Loading session…" : "Select a session to inspect it."}
            </div>
          ) : session.missing ? (
            <div className="flex h-[320px] items-center justify-center text-sm text-text-muted">
              This session is no longer in the details ring.
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-text-main">{selectedSummary?.label || session.id}</h3>
                    {session.live ? <Badge variant="success" size="sm" dot>live</Badge> : null}
                    <Badge variant={session.kind === "explicit" ? "primary" : "neutral"} size="sm">
                      {session.kind}
                    </Badge>
                    {session.monitor ? <Badge variant="info" size="sm">watched</Badge> : null}
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                    <span>{selectedSummary?.requests} request(s)</span>
                    <span>{fmtCompact(selectedSummary?.tokens || 0)} tokens</span>
                    <span>{fmtCost(selectedSummary?.costUsd || 0)}</span>
                    {selectedSummary?.models?.length ? <span className="truncate">{selectedSummary.models.join(", ")}</span> : null}
                    {session.spikes?.flagged?.length ? (
                      <span className="text-warning">{session.spikes.flagged.length} spike(s)</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl options={VIEWS} value={view} onChange={setView} size="sm" />
                  <Button
                    size="sm"
                    variant="outline"
                    icon={live ? "pause" : "play_arrow"}
                    onClick={() => setLive((value) => !value)}
                  >
                    {live ? "Pause stream" : "Resume stream"}
                  </Button>
                  <Button
                    size="sm"
                    variant={session.monitor ? "secondary" : "outline"}
                    icon="visibility"
                    loading={budgetSaving}
                    onClick={() => (session.monitor ? removeMonitor() : saveMonitor({ pinned: true }))}
                  >
                    {session.monitor ? "Unwatch" : "Monitor"}
                  </Button>
                </div>
              </div>

              {/* Budget + cumulative spend */}
              <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,260px)]">
                <div className="min-w-0 rounded-[10px] border border-border-subtle bg-bg p-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Cumulative spend</span>
                    <button
                      type="button"
                      className="text-[10px] text-primary"
                      onClick={() => setBudgetDraft({
                        cost: session.monitor?.budgetUsd != null ? String(session.monitor.budgetUsd) : "",
                        tokens: session.monitor?.budgetTokens != null ? String(session.monitor.budgetTokens) : "",
                      })}
                    >
                      set budget
                    </button>
                  </div>
                  <div className="h-[120px] w-full min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="var(--color-text-muted)" />
                        <YAxis tickFormatter={(value) => `$${Number(value).toFixed(2)}`} tick={{ fontSize: 9 }} stroke="var(--color-text-muted)" width={46} />
                        <ChartTooltip
                          contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 11 }}
                          formatter={(value, name) => [name === "cost" ? `$${Number(value).toFixed(4)}` : Number(value).toLocaleString(), name === "cost" ? "cumulative $" : "cumulative tokens"]}
                        />
                        <Area type="monotone" dataKey="cost" stroke="#f59e0b" fill="#f59e0b33" strokeWidth={2} />
                        {session.monitor?.budgetUsd ? (
                          <ReferenceLine y={session.monitor.budgetUsd} stroke="#ef4444" strokeDasharray="4 4" label={{ value: "budget", fontSize: 9, fill: "#ef4444" }} />
                        ) : null}
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg p-2.5 text-[11px] text-text-muted">
                  <span className="text-[10px] font-semibold uppercase tracking-wide">Budget</span>
                  {budget ? (
                    <>
                      {budget.costPct !== null ? (
                        <span className={cn(budget.costPct >= 100 ? "text-danger" : budget.costPct >= 80 ? "text-warning" : "")}>
                          cost {budget.costPct.toFixed(0)}% of {fmtCost(session.monitor?.budgetUsd)}
                        </span>
                      ) : null}
                      {budget.tokenPct !== null ? (
                        <span className={cn(budget.tokenPct >= 100 ? "text-danger" : budget.tokenPct >= 80 ? "text-warning" : "")}>
                          tokens {budget.tokenPct.toFixed(0)}% of {fmtCompact(session.monitor?.budgetTokens)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span>No budget set. Set one to get spend markers and spike context.</span>
                  )}
                  <div className="mt-1 flex flex-col gap-1">
                    <label className="flex items-center gap-1.5">
                      <span className="w-14">Cost $</span>
                      <input
                        value={budgetDraft.cost}
                        onChange={(event) => setBudgetDraft((draft) => ({ ...draft, cost: event.target.value }))}
                        placeholder="e.g. 2.50"
                        className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px]"
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      <span className="w-14">Tokens</span>
                      <input
                        value={budgetDraft.tokens}
                        onChange={(event) => setBudgetDraft((draft) => ({ ...draft, tokens: event.target.value }))}
                        placeholder="e.g. 2000000"
                        className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px]"
                      />
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={budgetSaving}
                      onClick={() =>
                        saveMonitor({
                          pinned: true,
                          budgetUsd: budgetDraft.cost === "" ? null : Number(budgetDraft.cost),
                          budgetTokens: budgetDraft.tokens === "" ? null : Number(budgetDraft.tokens),
                        })
                      }
                    >
                      Save budget
                    </Button>
                  </div>
                </div>
              </div>

              {/* Timeline / Chat */}
              <div className="min-w-0">
                {view === "timeline" ? (
                  <div className="flex max-h-[520px] min-w-0 flex-col overflow-y-auto rounded-[10px] border border-border-subtle">
                    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-subtle bg-bg/95 px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-text-muted backdrop-blur">
                      <span className="w-16">Time</span>
                      <span className="flex-1">Duration</span>
                      <span className="w-48 text-right">Metrics</span>
                    </div>
                    {turns.map((turn) => (
                      <div key={turn.id || turn.index} className="border-b border-border-subtle last:border-b-0">
                        <button
                          type="button"
                          onClick={() => setExpandedTurn((current) => (current === turn.id ? null : turn.id))}
                          className={cn(
                            "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2/50",
                            spikeIds.has(turn.id) && "bg-warning/5"
                          )}
                        >
                          <span className="w-16 shrink-0 font-mono text-[10px] text-text-muted">{flushName(turn)}</span>
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <SpikeIcon flags={turn.flags} />
                            <span className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                              <span
                                className={cn("absolute inset-y-0 left-0 rounded-full", costTone(turn, maxCost))}
                                style={{ width: `${Math.max(2, ((turn.total || 0) / maxTotal) * 100)}%` }}
                              />
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-text-muted">{turn.total ? fmtDuration(turn.total) : "—"}</span>
                          </span>
                          <span className="w-48 shrink-0 text-right">
                            <TurnBadges turn={turn} />
                          </span>
                        </button>
                        {expandedTurn === turn.id ? (
                          <div className="grid gap-2 border-t border-border-subtle bg-surface-2/30 p-2.5 text-[11px] text-text-muted sm:grid-cols-2">
                            <div className="min-w-0">
                              <p className="text-[10px] uppercase tracking-wide">Model</p>
                              <p className="truncate font-mono text-text-main">{turn.provider}/{turn.model}</p>
                              {turn.connectionName ? <p className="truncate">account {turn.connectionName}</p> : null}
                              {turn.routeSummary ? <p className="truncate">{turn.routeSummary}</p> : null}
                              {turn.flags?.map((flag) => (
                                <p key={flag.code} className="text-warning">{flag.message}</p>
                              ))}
                            </div>
                            <div className="min-w-0">
                              <p className="text-[10px] uppercase tracking-wide">Performance</p>
                              <p>
                                TTFT {turn.ttft ? `${turn.ttft}ms` : "—"} · total {turn.total ? `${turn.total}ms` : "—"}
                              </p>
                              <p>
                                in {turn.inputSpeed ? `${turn.inputSpeed.toFixed(0)} tok/s` : "—"} · out{" "}
                                {turn.outputSpeed ? `${turn.outputSpeed.toFixed(1)} tok/s` : "—"}
                              </p>
                              <p>
                                cache {turn.cacheHitRate !== null ? `${Math.round(turn.cacheHitRate * 100)}%` : "—"} · status {turn.status}
                              </p>
                            </div>
                            {turn.toolCalls?.length ? (
                              <div className="min-w-0 sm:col-span-2">
                                <p className="text-[10px] uppercase tracking-wide">Tool calls</p>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {turn.toolCalls.map((call, index) => (
                                    <span key={`${call.name}-${index}`} className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-text-main">
                                      {call.name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex max-h-[520px] min-w-0 flex-col gap-3 overflow-y-auto rounded-[10px] border border-border-subtle p-3">
                    {turns.map((turn) => (
                      <div key={turn.id || turn.index} className={cn("flex flex-col gap-1.5", spikeIds.has(turn.id) && "rounded-lg bg-warning/5 p-1.5")}>
                        <div className="flex items-center gap-2 text-[10px] text-text-subtle">
                          <span>turn #{turn.index + 1}</span>
                          <span>{flushName(turn)}</span>
                          <SpikeIcon flags={turn.flags} />
                          <TurnBadges turn={turn} />
                        </div>
                        {turn.userMessages?.length ? (
                          turn.userMessages.map((message, index) => (
                            <div key={`u-${index}`} className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary/10 px-3 py-2 text-xs text-text-main">
                              <p className="mb-0.5 text-[9px] uppercase tracking-wide text-text-muted">{message.role}</p>
                              <p className="whitespace-pre-wrap break-words">{message.text || (message.redacted ? "(content hidden)" : "")}</p>
                            </div>
                          ))
                        ) : (
                          <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-surface-2 px-3 py-1.5 text-[11px] italic text-text-muted">
                            (follow-up turn — no new user message)
                          </div>
                        )}
                        {turn.toolMessages?.length ? (
                          <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-2/70 px-3 py-2 font-mono text-[10px] text-text-muted">
                            {turn.toolMessages.map((message, index) => (
                              <p key={`t-${index}`} className="truncate">{message.text || "(tool result)"}</p>
                            ))}
                          </div>
                        ) : null}
                        <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-bg px-3 py-2 text-xs text-text-main ring-1 ring-border-subtle">
                          <p className="mb-0.5 text-[9px] uppercase tracking-wide text-text-muted">assistant</p>
                          {turn.assistant?.thinking ? (
                            <details className="mb-1">
                              <summary className="cursor-pointer text-[10px] text-text-muted">thinking</summary>
                              <p className="whitespace-pre-wrap break-words text-[11px] text-text-muted">{turn.assistant.thinking}</p>
                            </details>
                          ) : null}
                          <p className="whitespace-pre-wrap break-words">
                            {turn.assistant?.content || (turn.assistant?.redacted ? "(content hidden)" : turn.status !== "success" ? `(${turn.status})` : "(no content recorded)")}
                          </p>
                          {turn.toolCalls?.length ? (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {turn.toolCalls.map((call, index) => (
                                <span key={`${call.name}-${index}`} className="rounded-full bg-brand-500/10 px-2 py-0.5 font-mono text-[10px] text-brand-500">
                                  {call.name}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-[10px] text-text-muted">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
                  follow newest turn
                </label>
                <span>
                  stream: {live ? "SSE (live)" : "paused"} · {turns.length} turn(s) · median turn{" "}
                  {session.spikes?.tokenMedian ? `${fmtCompact(session.spikes.tokenMedian)} tok` : "—"} /{" "}
                  {session.spikes?.costMedian ? fmtCost(session.spikes.costMedian) : "—"}
                </span>
                {session.contentMode === "none" ? <span className="text-warning">content hidden by observability settings</span> : null}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function fmtTimeAgo(timestamp) {
  if (!timestamp) return "—";
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
