"use client";

import { cn } from "@/shared/utils/cn";
import { fmtCompact } from "./format";

/**
 * Segmented bar showing where tokens went: cached (cheap reads), fresh input,
 * output, and optionally the share flagged as avoidable ("potential").
 * The signature visual of the usage page.
 */
export default function TokenFlowBar({
  input = 0,
  cached = 0,
  output = 0,
  potential = 0,
  height = "h-2",
  showLegend = false,
  className,
}) {
  const safeCached = Math.min(Math.max(0, cached), Math.max(0, input));
  const fresh = Math.max(0, input - safeCached);
  const total = fresh + safeCached + output;
  const pct = (value) => (total > 0 ? (value / total) * 100 : 0);
  const potentialPct = total > 0 ? Math.min(100, (Math.max(0, potential) / (total + Math.max(0, potential))) * 100) : 0;

  if (total <= 0) {
    return <div className={cn("w-full rounded-full bg-surface-3/60", height, className)} />;
  }

  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)}>
      <div className={cn("flex w-full overflow-hidden rounded-full bg-surface-2", height)}>
        {safeCached > 0 && (
          <div
            className="bg-emerald-500/80"
            style={{ width: `${pct(safeCached)}%` }}
            title={`Cached: ${fmtCompact(safeCached)} tokens`}
          />
        )}
        {fresh > 0 && (
          <div
            className="bg-brand-500"
            style={{ width: `${pct(fresh)}%` }}
            title={`Fresh input: ${fmtCompact(fresh)} tokens`}
          />
        )}
        {output > 0 && (
          <div
            className="bg-blue-500/85"
            style={{ width: `${pct(output)}%` }}
            title={`Output: ${fmtCompact(output)} tokens`}
          />
        )}
      </div>
      {showLegend && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-emerald-500/80" /> Cached {fmtCompact(safeCached)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-brand-500" /> Input {fmtCompact(fresh)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-blue-500/85" /> Output {fmtCompact(output)}
          </span>
          {potential > 0 && (
            <span className="inline-flex items-center gap-1.5 text-warning">
              <span
                className="size-2 rounded-sm"
                style={{ backgroundImage: "repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 4px)" }}
              />
              ~{fmtCompact(potential)} avoidable
            </span>
          )}
        </div>
      )}
      {!showLegend && potentialPct > 0 && (
        <span className="sr-only">{potentialPct.toFixed(0)}% avoidable</span>
      )}
    </div>
  );
}
