"use client";

import { useMemo, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { turnDiagnostics } from "@/lib/usage/routingEvents";
import { MicroLabel } from "./primitives";

/**
 * Why an exchange cost or took what it did: cache misses, retries, reasoning
 * share, oversized prompts, slow prefill, spikes and hard failures.
 */
export default function DiagnosticsPanel({ turn }) {
  const notes = useMemo(() => turnDiagnostics(turn), [turn]);
  const [expanded, setExpanded] = useState(false);
  if (!notes.length) return null;

  const visible = expanded ? notes : notes.filter((note) => note.level !== "info");
  const hidden = notes.length - visible.length;

  return (
    <div className="flex flex-col gap-1.5">
      <MicroLabel>diagnostics</MicroLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        {visible.map((note, index) => (
          <span
            key={index}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] leading-relaxed",
              note.level === "error"
                ? "bg-danger/8 text-danger"
                : note.level === "warning"
                  ? "bg-warning/10 text-warning"
                  : "bg-surface-2 text-text-muted"
            )}
          >
            <span className="material-symbols-outlined text-[11px]">{note.icon}</span>
            {note.text}
          </span>
        ))}
        {hidden > 0 ? (
          <button type="button" onClick={() => setExpanded(true)} className="font-mono text-[10px] text-brand-500 hover:underline">
            +{hidden} more
          </button>
        ) : expanded && notes.some((note) => note.level === "info") ? (
          <button type="button" onClick={() => setExpanded(false)} className="font-mono text-[10px] text-text-subtle hover:underline">
            less
          </button>
        ) : null}
      </div>
    </div>
  );
}
