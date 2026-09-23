"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { fmtCompact, fmtCost } from "./format";
import ChatView from "./sessions/ChatView";
import TimelineView from "./sessions/TimelineView";
import { MicroLabel, StatPill, fmtDurationMs, fmtTimeAgo } from "./sessions/primitives";

const VIEWS = [
  { value: "chat", label: "Chat" },
  { value: "timeline", label: "Timeline" },
];

const FILTERS = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "watched", label: "Watched" },
  { value: "failing", label: "Failing" },
];

const REFRESH_MS = 10000;

/** Stable order: a session keeps its place while it receives new requests. */
function orderedSessions(list) {
  return [...list].sort((a, b) => {
    const left = new Date(a.startedAt || a.lastAt || 0).getTime() || 0;
    const right = new Date(b.startedAt || b.lastAt || 0).getTime() || 0;
    return right - left;
  });
}

export default function SessionsTab() {
  const searchParams = useSearchParams();
  const requestedSession = searchParams.get("session");
  const [sessions, setSessions] = useState([]);
  const [counts, setCounts] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);
  const [view, setView] = useState("chat");
  const [timelineMode, setTimelineMode] = useState("waterfall");
  const [live, setLive] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedTurn, setExpandedTurn] = useState(null);
  const [openRoutes, setOpenRoutes] = useState({});
  const [budgetDraft, setBudgetDraft] = useState({ cost: "", tokens: "" });
  const [content, setContent] = useState(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [spendOpen, setSpendOpen] = useState(false);
  const eventSourceRef = useRef(null);

  /* ------------------------------- session list ---------------------------- */

  const refreshList = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "80" });
      if (query.trim()) params.set("q", query.trim());
      const response = await fetch(`/api/usage/sessions?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load sessions");
      setSessions(orderedSessions(payload.sessions || []));
      setCounts(payload.counts || null);
      setError("");
      // Selection only falls back when nothing is chosen yet.
      setSelectedId((current) => requestedSession || current || payload.sessions?.[0]?.id || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [query, requestedSession]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshList();
    const timer = setInterval(refreshList, REFRESH_MS);
    const onFocus = () => void refreshList();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshList]);

  useEffect(() => {
    // Deep link from the routing canvas: ?tab=sessions&session=<id>
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requestedSession) setSelectedId(requestedSession);
  }, [requestedSession]);

  const visibleSessions = useMemo(() => {
    if (filter === "live") return sessions.filter((entry) => entry.live || entry.generating);
    if (filter === "watched") return sessions.filter((entry) => entry.monitored);
    if (filter === "failing") return sessions.filter((entry) => (entry.failures || 0) > 0);
    return sessions;
  }, [sessions, filter]);

  /* ----------------------------- session detail ---------------------------- */

  useEffect(() => {
    if (!selectedId) return undefined;
    // Reset per-session UI state when switching sessions.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(null);
    setExpandedTurn(null);
    setOpenRoutes({});
    setBudgetDraft({ cost: "", tokens: "" });
    setContent(null);

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
    let settled = false;
    // A cold stream can take a moment to open: fall back to the REST snapshot
    // once so the pane never sits on a loading state.
    const fallbackTimer = setTimeout(() => {
      if (settled) return;
      fetch(`/api/usage/sessions/${encodeURIComponent(selectedId)}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => {
          if (!settled) setSession((current) => current || payload);
        })
        .catch(() => {});
    }, 2500);
    const apply = (event) => {
      settled = true;
      clearTimeout(fallbackTimer);
      try {
        setSession(JSON.parse(event.data));
      } catch {
        // ignore malformed frame
      }
    };
    source.addEventListener("snapshot", apply);
    source.addEventListener("update", apply);
    source.onerror = () => {
      // the browser retries automatically; keep the last snapshot meanwhile
    };
    return () => {
      settled = true;
      clearTimeout(fallbackTimer);
      source.close();
      eventSourceRef.current = null;
    };
  }, [selectedId, live]);

  // Message text travels on its own channel so the chat renders while the model
  // is still generating (analytics arrive only when an exchange finishes).
  useEffect(() => {
    if (!selectedId || !live) return undefined;
    const source = new EventSource(`/api/usage/sessions/${encodeURIComponent(selectedId)}/content-stream`);
    const apply = (event) => {
      try {
        const payload = JSON.parse(event.data);
        setContent((current) => ({ past: payload.past || current?.past || [], live: payload.live || [] }));
      } catch {
        // ignore malformed frame
      }
    };
    source.addEventListener("snapshot", apply);
    source.addEventListener("delta", apply);
    return () => source.close();
  }, [selectedId, live]);

  useEffect(() => {
    if (!session?.live && !session?.generating) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.live, session?.generating]);

  /* -------------------------------- derived -------------------------------- */

  const turns = useMemo(() => session?.turns || [], [session]);
  const maxCost = useMemo(() => Math.max(0, ...turns.map((turn) => turn.costUsd || 0)), [turns]);
  const chartData = useMemo(
    () =>
      turns.map((turn, index) => ({
        label: `#${index + 1}`,
        cost: Number(turn.cumulativeCostUsd?.toFixed(4) || 0),
      })),
    [turns]
  );
  const spikeIds = useMemo(() => new Set((session?.spikes?.flagged || []).map((entry) => entry.turnId)), [session]);

  const timeline = useMemo(() => {
    if (turns.length === 0) return null;
    const starts = turns
      .map((turn) => new Date(turn.timestamp || 0).getTime())
      .filter((value) => Number.isFinite(value) && value > 0);
    const startMs = starts.length > 0 ? Math.min(...starts) : 0;
    const endMs = Math.max(...turns.map((turn) => (new Date(turn.timestamp || 0).getTime() || startMs) + (turn.total || 0)));
    const span = Math.max(1, endMs - startMs);
    const activeTotal = turns.reduce((sum, turn) => sum + (turn.total || 0), 0);
    const maxTurnDuration = Math.max(1, ...turns.map((turn) => turn.total || 0));
    return { startMs, endMs, span, activeTotal, maxTurnDuration, mostlyIdle: span > Math.max(120000, activeTotal * 12) };
  }, [turns]);

  const liveEntry = useMemo(() => (content?.live || []).find((entry) => entry.status === "streaming") || null, [content]);
  const routing = session?.routing || null;
  const summary = session?.summary || null;
  const budget = session?.budget || null;
  const cacheRate = summary?.tokens ? Math.round(((summary.cachedTokens || 0) / summary.tokens) * 100) : null;

  /* -------------------------------- actions -------------------------------- */

  const saveMonitor = useCallback(
    async (patch) => {
      if (!selectedId) return;
      setBudgetSaving(true);
      try {
        const response = await fetch("/api/usage/sessions/monitor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: selectedId, label: session?.summary?.label || null, ...patch }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not update the monitor");
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

  const toggleRoute = useCallback((key) => {
    setOpenRoutes((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const saveBudget = () =>
    saveMonitor({
      pinned: true,
      budgetUsd: budgetDraft.cost === "" ? null : Number(budgetDraft.cost),
      budgetTokens: budgetDraft.tokens === "" ? null : Number(budgetDraft.tokens),
    });

  /* --------------------------------- render -------------------------------- */

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-text-main">Sessions</h2>
          <p className="mt-0.5 text-[11.5px] text-text-muted">
            Every exchange with its routing decisions, spend and cache behaviour.
          </p>
        </div>
        {counts ? (
          <span className="flex items-center gap-2 font-mono text-[10px] text-text-subtle">
            <span className="inline-flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", counts.live > 0 ? "bg-emerald-500" : "bg-border")} />
              {counts.live} live
            </span>
            <span>· {counts.monitored} watched</span>
          </span>
        ) : null}
      </header>

      {error ? <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p> : null}

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(272px,320px)_minmax(0,1fr)]">
        {/* Session list */}
        <Card padding="none" className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-border-subtle px-3 py-2.5">
            <label className="relative block">
              <span className="material-symbols-outlined pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[15px] text-text-subtle">
                search
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sessions"
                className="h-8 w-full rounded-lg border border-border bg-bg pl-7 pr-2 text-xs text-text-main placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "rounded-md px-2 py-0.5 font-mono text-[10px] transition-colors",
                    filter === option.value
                      ? "bg-brand-500/12 text-brand-600 dark:text-brand-400"
                      : "text-text-subtle hover:bg-surface-2 hover:text-text-muted"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex max-h-[calc(100vh-260px)] min-h-[240px] flex-col overflow-y-auto overscroll-contain">
            {loading && sessions.length === 0 ? (
              <p className="p-4 text-center font-mono text-[10px] text-text-subtle">loading sessions…</p>
            ) : visibleSessions.length === 0 ? (
              <div className="flex flex-col gap-1 p-4 text-center">
                <span className="material-symbols-outlined text-[22px] text-text-subtle">forum</span>
                <p className="text-xs text-text-muted">
                  {sessions.length === 0 ? "Send a request through 9Router to start a session." : "No sessions match this filter."}
                </p>
              </div>
            ) : (
              visibleSessions.map((entry) => {
                const selected = selectedId === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedId(entry.id)}
                    className={cn(
                      "flex flex-col gap-1 border-l-2 px-3 py-2.5 text-left transition-colors",
                      selected ? "border-brand-500 bg-surface-2/60" : "border-transparent hover:bg-surface-2/40"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {entry.generating ? (
                        <span className="material-symbols-outlined animate-spin text-[12px] text-sky-500" title="generating now">
                          progress_activity
                        </span>
                      ) : entry.live ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" title="live" />
                      ) : (
                        <span className="size-1.5 shrink-0 rounded-full bg-border" />
                      )}
                      {entry.monitored ? (
                        <span className="material-symbols-outlined text-[13px] text-brand-500" title="watched">
                          visibility
                        </span>
                      ) : null}
                      {entry.budgetExceeded ? (
                        <span className="material-symbols-outlined text-[13px] text-danger" title="budget exceeded">
                          battery_alert
                        </span>
                      ) : null}
                      <span className="truncate text-[12.5px] font-medium text-text-main">{entry.label || entry.id}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-text-subtle">
                        {fmtTimeAgo(entry.lastAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 truncate font-mono text-[9.5px] text-text-subtle">
                      <span className="truncate text-text-muted">{entry.model || "—"}</span>
                      <span>· {entry.requests} req</span>
                      <span>· {fmtCompact(entry.tokens)}</span>
                      <span>· {fmtCost(entry.costUsd)}</span>
                      {entry.failures > 0 ? <span className="text-danger">· {entry.failures} failed</span> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {/* Session detail */}
        <Card padding="none" className="flex min-w-0 flex-col">
          {!session ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <span className="material-symbols-outlined text-[24px] text-text-subtle">conversion_path</span>
              <p className="text-sm text-text-main">{selectedId ? "Loading session…" : "Select a session"}</p>
              <p className="max-w-xs text-xs text-text-muted">Pick one on the left to read its conversation and routing trace.</p>
            </div>
          ) : session.missing ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <span className="material-symbols-outlined text-[24px] text-text-subtle">history</span>
              <p className="text-sm text-text-main">This session aged out</p>
              <p className="max-w-xs text-xs text-text-muted">Its details left the recent ring — only aggregate usage remains.</p>
            </div>
          ) : (
            <>
              {/* Sticky session header */}
              <div className="sticky top-0 z-20 flex flex-col gap-2.5 rounded-t-[14px] border-b border-border bg-surface/85 px-4 py-3 backdrop-blur">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 truncate text-[13.5px] font-semibold text-text-main">{summary?.label || session.id}</h3>
                  {session.generating ? (
                    <Badge variant="info" size="sm">
                      generating
                    </Badge>
                  ) : session.live ? (
                    <Badge variant="success" size="sm" dot>
                      live
                    </Badge>
                  ) : null}
                  <Badge variant={session.kind === "explicit" ? "primary" : "neutral"} size="sm">
                    {session.kind}
                  </Badge>
                  {session.monitor ? (
                    <Badge variant="info" size="sm">
                      watched
                    </Badge>
                  ) : null}
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <SegmentedControl options={VIEWS} value={view} onChange={setView} size="sm" />
                    <Button
                      size="sm"
                      variant="outline"
                      icon={live ? "pause" : "play_arrow"}
                      onClick={() => setLive((value) => !value)}
                      title={live ? "Pause both streams" : "Resume streaming"}
                    >
                      {live ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      size="sm"
                      variant={session.monitor ? "secondary" : "outline"}
                      icon="visibility"
                      loading={budgetSaving}
                      onClick={() => (session.monitor ? removeMonitor() : saveMonitor({ pinned: true }))}
                    >
                      {session.monitor ? "Unwatch" : "Watch"}
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <StatPill label="req" value={summary?.requests ?? 0} />
                  <StatPill label="tok" value={fmtCompact(summary?.tokens || 0)} />
                  <StatPill label="$" value={fmtCost(summary?.costUsd || 0).replace("$", "")} />
                  {cacheRate !== null ? <StatPill label="cache" value={`${cacheRate}%`} /> : null}
                  {routing?.fallbacks ? (
                    <StatPill label="fallbacks" value={routing.fallbacks} tone="text-warning" title="attempts that rotated to another account" />
                  ) : null}
                  {summary?.failures ? (
                    <StatPill label="failed" value={summary.failures} tone="text-danger" title="requests that ended in an error" />
                  ) : null}
                  {session.spikes?.tokenMedian ? (
                    <StatPill label="median" value={fmtCompact(session.spikes.tokenMedian)} title="median tokens per exchange" />
                  ) : null}
                  {session.spikes?.flagged?.length ? (
                    <StatPill label="spikes" value={session.spikes.flagged.length} tone="text-warning" />
                  ) : null}
                  {routing?.contextProblems ? <StatPill label="ctx" value={routing.contextProblems} tone="text-danger" /> : null}
                  {routing?.providers?.length ? (
                    <span className="flex flex-wrap items-center gap-1 pl-1">
                      {routing.providers.slice(0, 3).map((provider) => (
                        <span key={provider.name} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-text-muted">
                          {provider.name} ×{provider.count}
                        </span>
                      ))}
                      {routing.accounts?.slice(0, 2).map((account) => (
                        <span key={account.name} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-text-subtle">
                          {account.name}
                        </span>
                      ))}
                      {routing.combos?.map((combo) => (
                        <span key={combo.name} className="rounded-md bg-brand-500/10 px-1.5 py-0.5 font-mono text-[9.5px] text-brand-600 dark:text-brand-400">
                          {combo.name}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Views */}
              <div className="min-w-0 p-3">
                {view === "chat" ? (
                  <ChatView
                    key={session.id}
                    session={session}
                    turns={turns}
                    content={content}
                    openRoutes={openRoutes}
                    onToggleRoute={toggleRoute}
                    now={now}
                    maxCost={maxCost}
                  />
                ) : (
                  <TimelineView
                    session={session}
                    turns={turns}
                    timeline={timeline}
                    timelineMode={timelineMode}
                    setTimelineMode={setTimelineMode}
                    expandedTurn={expandedTurn}
                    setExpandedTurn={setExpandedTurn}
                    spikeIds={spikeIds}
                    maxCost={maxCost}
                    liveEntry={liveEntry}
                    now={now}
                  />
                )}
              </div>

              {/* Spend & budget */}
              <div className="border-t border-border-subtle px-3 py-2">
                <button
                  type="button"
                  onClick={() => setSpendOpen((value) => !value)}
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-2/50"
                >
                  <span className="material-symbols-outlined text-[14px] text-text-subtle">trending_up</span>
                  <MicroLabel>spend &amp; budget</MicroLabel>
                  <span className="font-mono text-[10px] tabular-nums text-text-subtle">
                    {fmtCost(summary?.costUsd || 0)}
                    {budget?.costPct != null ? ` · ${budget.costPct.toFixed(0)}% of budget` : ""}
                  </span>
                  <span
                    className={cn(
                      "material-symbols-outlined ml-auto text-[16px] text-text-subtle transition-transform",
                      spendOpen && "rotate-180"
                    )}
                  >
                    expand_more
                  </span>
                </button>

                {spendOpen ? (
                  <div className="grid min-w-0 gap-3 pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(220px,260px)]">
                    <div className="min-w-0 rounded-xl border border-border-subtle bg-bg p-2.5">
                      <div className="mb-1 flex items-center justify-between">
                        <MicroLabel>cumulative spend</MicroLabel>
                        <button
                          type="button"
                          className="font-mono text-[10px] text-brand-500 hover:underline"
                          onClick={() =>
                            setBudgetDraft({
                              cost: session.monitor?.budgetUsd != null ? String(session.monitor.budgetUsd) : "",
                              tokens: session.monitor?.budgetTokens != null ? String(session.monitor.budgetTokens) : "",
                            })
                          }
                        >
                          set budget
                        </button>
                      </div>
                      <div className="h-[110px] w-full min-w-0">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={chartData} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                            <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="var(--color-text-muted)" />
                            <YAxis
                              tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
                              tick={{ fontSize: 9 }}
                              stroke="var(--color-text-muted)"
                              width={44}
                            />
                            <ChartTooltip
                              contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 11 }}
                              formatter={(value) => [`$${Number(value).toFixed(4)}`, "cumulative"]}
                            />
                            <Area
                              type="monotone"
                              dataKey="cost"
                              stroke="var(--color-brand-500)"
                              fill="var(--color-brand-500)"
                              fillOpacity={0.12}
                              strokeWidth={2}
                              isAnimationActive={false}
                            />
                            {session.monitor?.budgetUsd ? (
                              <ReferenceLine
                                y={session.monitor.budgetUsd}
                                stroke="var(--color-danger)"
                                strokeDasharray="4 4"
                                label={{ value: "budget", fontSize: 9, fill: "var(--color-danger)" }}
                              />
                            ) : null}
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-subtle bg-bg p-2.5 text-[11px] text-text-muted">
                      <MicroLabel>budget</MicroLabel>
                      {budget ? (
                        <>
                          {budget.costPct !== null ? (
                            <span className={cn("font-mono text-[10.5px] tabular-nums", budget.costPct >= 100 ? "text-danger" : budget.costPct >= 80 ? "text-warning" : "")}>
                              cost {budget.costPct.toFixed(0)}% of {fmtCost(session.monitor?.budgetUsd)}
                            </span>
                          ) : null}
                          {budget.tokenPct !== null ? (
                            <span className={cn("font-mono text-[10.5px] tabular-nums", budget.tokenPct >= 100 ? "text-danger" : budget.tokenPct >= 80 ? "text-warning" : "")}>
                              tokens {budget.tokenPct.toFixed(0)}% of {fmtCompact(session.monitor?.budgetTokens)}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[11px] leading-relaxed">No budget set. One adds a marker to the chart and spike context.</span>
                      )}
                      <div className="mt-1 flex flex-col gap-1.5">
                        <label className="flex items-center gap-2">
                          <span className="w-12 font-mono text-[10px] text-text-subtle">cost $</span>
                          <input
                            value={budgetDraft.cost}
                            onChange={(event) => setBudgetDraft((draft) => ({ ...draft, cost: event.target.value }))}
                            placeholder="2.50"
                            className="h-7 w-full rounded-md border border-border bg-surface px-2 font-mono text-[11px] tabular-nums"
                          />
                        </label>
                        <label className="flex items-center gap-2">
                          <span className="w-12 font-mono text-[10px] text-text-subtle">tokens</span>
                          <input
                            value={budgetDraft.tokens}
                            onChange={(event) => setBudgetDraft((draft) => ({ ...draft, tokens: event.target.value }))}
                            placeholder="2000000"
                            className="h-7 w-full rounded-md border border-border bg-surface px-2 font-mono text-[11px] tabular-nums"
                          />
                        </label>
                        <Button size="sm" variant="outline" loading={budgetSaving} onClick={saveBudget}>
                          Save budget
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle px-4 py-2 font-mono text-[10px] text-text-subtle">
                <span>
                  {live ? "streaming" : "paused"} · {turns.length} exchange{turns.length === 1 ? "" : "s"} · busy{" "}
                  {fmtDurationMs(timeline?.activeTotal)}
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
