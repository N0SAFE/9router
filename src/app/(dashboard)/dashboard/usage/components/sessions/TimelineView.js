"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { eventsFromTrace, isSuccessStatus } from "@/lib/usage/routingEvents";
import { fmtCost } from "../format";
import { MicroLabel, RailNode, fmtClock, fmtDurationMs, fmtOffset, providerModel } from "./primitives";
import RoutingTracePanel from "./RoutingTracePanel";
import DiagnosticsPanel from "./DiagnosticsPanel";
import TurnMetrics from "./TurnMetrics";

const MODES = [
  { value: "waterfall", label: "Waterfall" },
  { value: "relative", label: "Relative" },
];

const TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1];

export default function TimelineView({
  session,
  turns,
  timeline,
  timelineMode,
  setTimelineMode,
  expandedTurn,
  setExpandedTurn,
  spikeIds,
  maxCost,
  liveEntry,
  now,
  jumpRequest,
  onActiveIndex,
}) {
  const nowMs = now;
  const scrollRef = useRef(null);
  const [flashIndex, setFlashIndex] = useState(null);
  const flashTimer = useRef(null);

  const revealIndex = useCallback(
    (index) => {
      const container = scrollRef.current;
      if (!container) return;
      const node = container.querySelector(`[data-exchange="${index}"]`);
      if (!node) return;
      container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
      setFlashIndex(index);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashIndex(null), 1500);
      onActiveIndex?.(index);
    },
    [onActiveIndex]
  );

  useEffect(() => {
    if (jumpRequest?.nonce) revealIndex(jumpRequest.index);
  }, [jumpRequest, revealIndex]);
  const liveStart = liveEntry?.startedAt || null;
  const liveOffset = liveStart && timeline ? Math.max(0, liveStart - timeline.startMs) : null;
  const livePct =
    timelineMode === "relative" ? 0 : Math.min(100, Math.max(0, ((liveOffset || 0) / (timeline?.span || 1)) * 100));

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-brand-lg)] border border-border bg-bg">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-4 py-2">
        <MicroLabel>waterfall</MicroLabel>
        <span className="font-mono text-[10px] tabular-nums text-text-subtle">
          span {fmtDurationMs(timeline?.span)} · busy {fmtDurationMs(timeline?.activeTotal)} · {turns.length} exchange
          {turns.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto">
          <SegmentedControl options={MODES} value={timelineMode} onChange={setTimelineMode} size="sm" />
        </span>
      </header>

      {timeline?.mostlyIdle && timelineMode === "waterfall" ? (
        <p className="border-b border-border bg-warning/5 px-4 py-1.5 text-[10.5px] text-warning">
          Exchanges are spread over a long window — switch to Relative to compare durations.
        </p>
      ) : null}

      {/* ruler */}
      <div className="flex items-center gap-3 border-b border-border bg-surface-2/30 px-4 py-1">
        <span className="w-40 shrink-0">
          <MicroLabel>exchange · started</MicroLabel>
        </span>
        <span className="relative h-4 min-w-0 flex-1">
          {TICKS.map((fraction, index) => (
            <span key={fraction} className="absolute top-0 h-4 border-l border-border/70" style={{ left: `${fraction * 100}%` }}>
              <span
                className={cn(
                  "absolute top-0 whitespace-nowrap pl-1 font-mono text-[9px] tabular-nums text-text-subtle",
                  index === TICKS.length - 1 && "-translate-x-full pl-0 pr-1"
                )}
              >
                {timelineMode === "relative"
                  ? fmtDurationMs(fraction * (timeline?.maxTurnDuration || 0))
                  : fmtOffset(fraction * (timeline?.span || 0))}
              </span>
            </span>
          ))}
          {session.generating && timeline ? (
            <span
              className="absolute inset-y-0 w-px bg-sky-500/80"
              style={{ left: `${Math.min(100, Math.max(0, ((nowMs - timeline.startMs) / (timeline.span || 1)) * 100))}%` }}
            />
          ) : null}
        </span>
        <span className="w-64 shrink-0 text-right">
          <MicroLabel>per exchange</MicroLabel>
        </span>
      </div>

      <div ref={scrollRef} className="session-scroll max-h-[min(72vh,780px)] min-w-0 overflow-y-auto overscroll-contain">
        {turns.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-text-muted">No completed exchanges yet.</p>
        ) : null}

        {turns.map((turn, position) => {
          const startedMs = new Date(turn.timestamp || 0).getTime() || timeline?.startMs || 0;
          const offset = Math.max(0, startedMs - (timeline?.startMs || 0));
          const duration = turn.total || 0;
          const prefill = Math.min(turn.ttft || 0, duration);
          const denominator = timelineMode === "relative" ? timeline?.maxTurnDuration || 1 : timeline?.span || 1;
          const leftPct = timelineMode === "relative" ? 0 : (offset / denominator) * 100;
          const widthPct = Math.max(0.4, (duration / denominator) * 100);
          const failed = !isSuccessStatus(turn.status);
          const toolCount = turn.toolCalls?.length || 0;
          const previous = turns[position - 1];
          const previousEnd = previous
            ? Math.max(0, new Date(previous.timestamp || 0).getTime() - (timeline?.startMs || 0) + (previous.total || 0))
            : 0;
          const gapMs = position > 0 ? Math.max(0, offset - previousEnd) : 0;
          const gapPct = timelineMode === "waterfall" ? (gapMs / (timeline?.span || 1)) * 100 : 0;
          const key = turn.id || `turn-${turn.index}`;
          const opened = expandedTurn === key;

          return (
            <div key={key} className="border-b border-border last:border-b-0">
              <button
                type="button"
                data-exchange={turn.index}
                onClick={() => {
                  setExpandedTurn((current) => (current === key ? null : key));
                  onActiveIndex?.(turn.index);
                }}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-surface-2/40",
                  spikeIds.has(turn.id) && "bg-warning/5",
                  flashIndex === turn.index && "exchange-flash"
                )}
              >
                <span className="flex w-40 shrink-0 items-center gap-2">
                  <span className="flex w-4 justify-center">
                    <RailNode
                      status={failed ? "error" : turn.status}
                      turn={turn}
                      maxCost={maxCost}
                      showPhase={false}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-mono text-[10.5px] tabular-nums text-text-main">
                      #{String(turn.index + 1).padStart(2, "0")} · {fmtClock(turn.timestamp)}
                    </span>
                    <span className="block truncate font-mono text-[9.5px] text-text-subtle">
                      {timelineMode === "relative" ? fmtDurationMs(duration) : fmtOffset(offset)} · {providerModel(turn)}
                    </span>
                  </span>
                </span>

                <span className="relative h-7 min-w-0 flex-1">
                  {[0.2, 0.4, 0.6, 0.8].map((fraction) => (
                    <span key={fraction} className="absolute inset-y-0 border-l border-border/30" style={{ left: `${fraction * 100}%` }} />
                  ))}
                  {gapPct > 4 ? (
                    <span
                      className="absolute inset-y-2.5 rounded-full border border-dashed border-border"
                      style={{ left: `${(previousEnd / (timeline?.span || 1)) * 100}%`, width: `${gapPct}%` }}
                      title={`idle ${fmtDurationMs(gapMs)}`}
                    />
                  ) : null}
                  <span className="absolute inset-y-0" style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 3 }}>
                    <span
                      className="absolute inset-y-1.5 left-0 right-0 flex overflow-hidden rounded-[3px] ring-1 ring-inset ring-black/5"
                      title={`#${turn.index + 1} ${providerModel(turn)} · ${fmtDurationMs(duration)} · ttft ${turn.ttft ? `${turn.ttft}ms` : "—"} · ${turn.tokens.input} in / ${turn.tokens.output} out · ${fmtCost(turn.costUsd)}${toolCount ? ` · ${toolCount} tool call(s)` : ""}`}
                    >
                      {failed ? (
                        <span className="h-full w-full bg-red-500/80" />
                      ) : (
                        <>
                          <span className="h-full bg-cyan-500/70" style={{ width: `${duration > 0 ? (prefill / duration) * 100 : 0}%` }} />
                          <span
                            className={cn(
                              "h-full flex-1",
                              !turn.costUsd || !maxCost
                                ? "bg-emerald-500/70"
                                : turn.costUsd / maxCost >= 0.75
                                  ? "bg-red-500/80"
                                  : turn.costUsd / maxCost >= 0.4
                                    ? "bg-amber-500/80"
                                    : "bg-emerald-500/70"
                            )}
                          />
                        </>
                      )}
                    </span>
                    {spikeIds.has(turn.id) ? (
                      <span
                        className="absolute -top-1.5 left-1/2 -translate-x-1/2 text-[10px] leading-none"
                        title={turn.flags?.map((flag) => flag.message).join("\n")}
                      >
                        🔥
                      </span>
                    ) : null}
                    {toolCount > 0 ? (
                      <span className="absolute -bottom-0.5 left-0 flex gap-0.5">
                        {Array.from({ length: Math.min(toolCount, 6) }, (_, index) => (
                          <span key={index} className="size-1 rounded-full bg-amber-500 ring-1 ring-bg" />
                        ))}
                      </span>
                    ) : null}
                  </span>
                </span>

                <span className="flex w-64 shrink-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-text-muted">
                  <TurnMetrics turn={turn} />
                </span>
              </button>

              {opened ? (
                <div className="flex flex-col gap-3 border-t border-border bg-surface-2/20 px-4 py-3">
                  <div className="grid gap-3 text-[11px] text-text-muted sm:grid-cols-2">
                    <div className="min-w-0">
                      <MicroLabel>model</MicroLabel>
                      <p className="mt-1 truncate font-mono text-text-main">{providerModel(turn)}</p>
                      {turn.connectionName ? <p className="truncate font-mono text-[10.5px]">account {turn.connectionName}</p> : null}
                      {turn.routeSummary ? <p className="truncate font-mono text-[10.5px]">{turn.routeSummary}</p> : null}
                    </div>
                    <div className="min-w-0">
                      <MicroLabel>performance</MicroLabel>
                      <p className="mt-1 font-mono text-[10.5px] tabular-nums">
                        ttft {turn.ttft ? `${turn.ttft}ms` : "—"} · total {turn.total ? `${turn.total}ms` : "—"}
                      </p>
                      <p className="font-mono text-[10.5px] tabular-nums">
                        in {turn.inputSpeed ? `${turn.inputSpeed.toFixed(0)}/s` : "—"} · out{" "}
                        {turn.outputSpeed ? `${turn.outputSpeed.toFixed(1)}/s` : "—"}
                      </p>
                    </div>
                  </div>
                  <DiagnosticsPanel turn={turn} />
                  <div className="min-w-0">
                    <MicroLabel>routing</MicroLabel>
                    <div className="mt-1.5">
                      <RoutingTracePanel events={eventsFromTrace(turn)} />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        {session.generating && liveEntry ? (
          <div className="flex items-center gap-3 px-4 py-2">
            <span className="flex w-40 shrink-0 items-center gap-2">
              <span className="flex w-4 justify-center">
                <RailNode live phase={liveEntry.phase} />
              </span>
              <span className="min-w-0">
                <span className="block font-mono text-[10.5px] text-sky-600 dark:text-sky-400">
                  #{String(turns.length + 1).padStart(2, "0")} · live
                </span>
                <span className="block font-mono text-[9.5px] tabular-nums text-text-subtle">{fmtClock(liveStart)}</span>
              </span>
            </span>
            <span className="relative h-7 min-w-0 flex-1">
              <span
                className="absolute inset-y-1.5 animate-pulse rounded-[3px] bg-sky-500/40 ring-1 ring-inset ring-sky-500/40"
                style={{
                  left: `${livePct}%`,
                  width: `${Math.max(
                    0.5,
                    ((nowMs - (liveStart || nowMs)) / (timelineMode === "relative" ? timeline?.maxTurnDuration || 1 : timeline?.span || 1)) * 100
                  )}%`,
                }}
              />
            </span>
            <span className="w-64 shrink-0 text-right font-mono text-[10px] text-sky-600 dark:text-sky-400">
              {liveEntry.phase || "routing"}…
            </span>
          </div>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-1.5 font-mono text-[9.5px] text-text-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-cyan-500/70" /> prefill
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-emerald-500/80" /> generation
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-amber-500" /> tools
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-red-500" /> failed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm border border-dashed border-border" /> idle
        </span>
        <span className="ml-auto normal-case">bar = duration · colour = cost vs session max</span>
      </footer>
    </section>
  );
}
