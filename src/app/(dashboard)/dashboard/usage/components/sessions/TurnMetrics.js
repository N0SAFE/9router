"use client";

import { cn } from "@/shared/utils/cn";
import { fmtCompact, fmtCost } from "../format";
import { fmtDurationMs } from "./primitives";

function Metric({ label, value, tone, title }) {
  return (
    <span className="inline-flex items-baseline gap-1" title={title}>
      <span className="text-[9.5px] uppercase tracking-[0.1em] text-text-subtle">{label}</span>
      <span className={cn("font-medium tabular-nums", tone)}>{value}</span>
    </span>
  );
}

/** Compact mono metrics line shared by the chat footer and the timeline rows. */
export default function TurnMetrics({ turn }) {
  if (!turn) return null;
  return (
    <>
      <Metric label="in" value={fmtCompact(turn.tokens.input)} tone="text-text-main" />
      {turn.tokens.cached > 0 ? (
        <Metric label="hit" value={fmtCompact(turn.tokens.cached)} tone="text-emerald-600 dark:text-emerald-400" />
      ) : null}
      <Metric label="out" value={fmtCompact(turn.tokens.output)} tone="text-text-main" />
      {turn.tokens.reasoning > 0 ? <Metric label="think" value={fmtCompact(turn.tokens.reasoning)} /> : null}
      <Metric
        label="$"
        value={fmtCost(turn.costUsd).replace("$", "")}
        tone={turn.costUsd >= 0.05 ? "text-warning" : undefined}
      />
      {turn.ttft ? <Metric label="ttft" value={fmtDurationMs(turn.ttft)} /> : null}
      {turn.total ? <Metric label="total" value={fmtDurationMs(turn.total)} /> : null}
      {turn.outputSpeed ? <Metric label="speed" value={`${turn.outputSpeed.toFixed(1)}/s`} /> : null}
      {turn.cacheHitRate !== null && turn.cacheHitRate !== undefined && turn.tokens.input > 0 ? (
        <Metric label="cache" value={`${Math.round(turn.cacheHitRate * 100)}%`} />
      ) : null}
      {turn.toolCalls?.length ? <Metric label="tools" value={turn.toolCalls.length} tone="text-brand-500" /> : null}
    </>
  );
}
