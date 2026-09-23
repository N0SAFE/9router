"use client";

import { cn } from "@/shared/utils/cn";
import { MicroLabel } from "./primitives";

const EVENT_ICON = {
  combo: "account_tree",
  "combo-model": "model_training",
  model: "model_training",
  pool: "hub",
  account: "account_circle",
  attempt: "warning",
  fallback: "restart_alt",
  error: "error",
  streaming: "play_circle",
  complete: "check_circle",
  note: "info",
};

const EVENT_TONE = {
  combo: "text-brand-500",
  "combo-model": "text-text-muted",
  model: "text-text-main",
  pool: "text-text-muted",
  account: "text-emerald-500",
  attempt: "text-warning",
  fallback: "text-warning",
  error: "text-danger",
  streaming: "text-sky-500",
  complete: "text-emerald-500",
  note: "text-text-muted",
};

/** Ordered routing events for one exchange (combo → model → pool → account → attempts). */
export default function RoutingTracePanel({ events }) {
  if (!events?.length) {
    return (
      <p className="rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[11px] text-text-muted">
        No routing trace recorded.
      </p>
    );
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface">
      {events.map((event, index) => (
        <div
          key={index}
          className={cn(
            "flex items-start gap-2 border-b border-border-subtle px-3 py-1.5 last:border-b-0",
            event.type === "error" && "bg-danger/5",
            event.type === "fallback" && "bg-warning/5"
          )}
        >
          <span className={cn("material-symbols-outlined mt-0.5 text-[13px]", EVENT_TONE[event.type] || "text-text-muted")}>
            {EVENT_ICON[event.type] || "info"}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 break-words font-mono text-[10.5px] leading-relaxed",
              event.type === "error" ? "text-danger" : "text-text-main"
            )}
          >
            {event.message || event.type}
          </span>
          {event.status != null ? (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-text-muted">{event.status}</span>
          ) : null}
          {event.action ? (
            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[9.5px] text-warning">{event.action}</span>
          ) : null}
        </div>
      ))}
      <span className="px-3 py-1">
        <MicroLabel>events streamed from the router</MicroLabel>
      </span>
    </div>
  );
}
