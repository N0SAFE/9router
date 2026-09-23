"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";

/* ------------------------------- formatting ------------------------------- */

export function fmtClock(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

export function fmtOffset(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "+0s";
  if (ms < 60000) return `+${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60000);
  return `+${minutes}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

export function fmtTimeAgo(timestamp) {
  if (!timestamp) return "—";
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function providerModel(turn) {
  const provider = turn?.provider || turn?.routing?.provider;
  const model = turn?.model || turn?.routing?.model;
  return [provider, model].filter(Boolean).join("/") || "—";
}

/** Generation colour: quiet when cheap, warm when it eats the session budget. */
export function costTone(costUsd, maxCost) {
  if (!costUsd || !maxCost) return "bg-emerald-500/70";
  const ratio = costUsd / maxCost;
  if (ratio >= 0.75) return "bg-red-500/80";
  if (ratio >= 0.4) return "bg-amber-500/80";
  return "bg-emerald-500/70";
}

export const PHASES = {
  routing: { label: "routing", tone: "text-text-muted", dot: "bg-text-subtle" },
  thinking: { label: "thinking", tone: "text-brand-500", dot: "bg-brand-500" },
  writing: { label: "writing", tone: "text-sky-600 dark:text-sky-400", dot: "bg-sky-500" },
  done: { label: "done", tone: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  error: { label: "failed", tone: "text-danger", dot: "bg-danger" },
};

/* --------------------------------- primitives ----------------------------- */

export function MicroLabel({ children, className, as: Tag = "span" }) {
  return (
    <Tag className={cn("font-mono text-[9.5px] uppercase tracking-[0.16em] text-text-subtle", className)}>{children}</Tag>
  );
}

export function StatPill({ label, value, tone, title }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-baseline gap-1 rounded-md border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
        tone || "text-text-muted"
      )}
    >
      <span className="text-[9px] uppercase tracking-[0.12em] text-text-subtle">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

/** Node on the conversation rail: outcome dot, live pulse, micro phase bar. */
export function RailNode({ status, live, phase, turn, maxCost, showPhase = true }) {
  const failed = status && !["ok", "success"].includes(status);
  const retried = !failed && Number(turn?.routing?.attempts?.length || 0) > 0;
  const dot = failed ? "bg-danger" : live ? "bg-sky-500" : retried ? "bg-warning" : "bg-emerald-500";

  return (
    <span className="flex flex-col items-center gap-1">
      <span className={cn("relative mt-1 flex size-2.5 items-center justify-center rounded-full ring-2 ring-bg", dot)}>
        {live ? <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", dot)} /> : null}
      </span>
      {showPhase && (live || turn?.total) ? <PhaseBar turn={turn} live={live} phase={phase} maxCost={maxCost} /> : null}
    </span>
  );
}

/** Prefill (cyan) → generation (cost tone) as a 20px vertical strip. */
export function PhaseBar({ turn, live, phase, maxCost }) {
  const prefillPct = turn?.total ? Math.min(100, Math.round(((turn.ttft || 0) / turn.total) * 100)) : 0;
  if (live) {
    const tone = PHASES[phase] || PHASES.routing;
    return (
      <span className="relative h-5 w-[3px] overflow-hidden rounded-full bg-border-subtle" title={tone.label}>
        <span className={cn("absolute inset-x-0 top-0 animate-pulse rounded-full", tone.dot)} style={{ height: "60%" }} />
      </span>
    );
  }
  if (!turn?.total) return null;
  return (
    <span
      className="flex h-5 w-[3px] flex-col overflow-hidden rounded-full bg-border-subtle"
      title={`prefill ${fmtDurationMs(turn.ttft)} · generation ${fmtDurationMs(Math.max(0, (turn.total || 0) - (turn.ttft || 0)))}`}
    >
      <span className="w-full bg-cyan-500/70" style={{ height: `${prefillPct}%` }} />
      <span className={cn("w-full flex-1", costTone(turn.costUsd, maxCost))} />
    </span>
  );
}

export function Avatar({ role }) {
  const isUser = role === "user";
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full ring-1",
        isUser ? "bg-brand-500/12 text-brand-600 ring-brand-500/20 dark:text-brand-400" : "bg-surface-2 text-text-muted ring-border"
      )}
    >
      <span className="material-symbols-outlined text-[15px]">{isUser ? "person" : "auto_awesome"}</span>
    </span>
  );
}

export function Shimmer() {
  return (
    <span className="flex flex-col gap-1.5 py-0.5">
      {[88, 72, 54].map((width, index) => (
        <span key={index} className="block h-2.5 animate-pulse rounded-full bg-border-subtle" style={{ width: `${width}%` }} />
      ))}
    </span>
  );
}

/** Clipboard helper with a short-lived "copied" flag. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
      return true;
    } catch {
      return false;
    }
  }, []);
  return { copied, copy };
}

/**
 * Session minimap: one tick per exchange, height = duration, colour = outcome,
 * amber underline = cache miss, pulsing tick while a request is in flight.
 * Click a tick (or focus the strip and use ←/→) to jump to an exchange.
 */
export function SessionMinimap({ turns = [], spikeIds, liveEntry, activeIndex = null, onJump }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  const count = turns.length;
  const maxDuration = Math.max(1, ...turns.map((turn) => turn.total || 0));

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect?.width || 0;
      setWidth((current) => (Math.abs(current - next) > 1 ? next : current));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const gap = 2;
  const barWidth = count > 0 && width > 0 ? Math.max(2, Math.min(9, (width - gap * (count - 1) - 12) / count)) : 3;

  const jumpTo = (index) => {
    if (index >= 0 && index < count) onJump?.(index);
  };

  return (
    <div className="flex min-w-0 items-center gap-3">
      <MicroLabel className="shrink-0">exchanges</MicroLabel>
      <div
        ref={ref}
        role="slider"
        tabIndex={count > 0 ? 0 : -1}
        aria-label="Session exchanges — click or use arrow keys to jump"
        aria-valuemin={count > 0 ? 1 : 0}
        aria-valuemax={count}
        aria-valuenow={activeIndex !== null && activeIndex !== undefined ? activeIndex + 1 : undefined}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            jumpTo(Math.min(count - 1, (activeIndex ?? -1) + 1));
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            jumpTo(Math.max(0, (activeIndex ?? 1) - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            jumpTo(activeIndex ?? 0);
          }
        }}
        className="flex h-10 min-w-0 flex-1 items-end gap-[2px] overflow-hidden rounded-lg border border-border-subtle bg-surface-2/40 px-1.5 pb-1 pt-1.5"
      >
        {turns.map((turn, index) => {
          const duration = turn.total || 0;
          const height = 10 + (duration / maxDuration) * 22;
          const failed = turn.status && !["ok", "success"].includes(turn.status);
          const retried = !failed && (turn.routing?.attempts?.length || 0) > 0;
          const cacheMiss = (turn.tokens?.input || 0) >= 2000 && !(turn.tokens?.cached || 0);
          const spike = spikeIds?.has(turn.id);
          const active = activeIndex === index;
          return (
            <button
              key={turn.id || index}
              type="button"
              tabIndex={-1}
              onClick={() => jumpTo(index)}
              title={`#${index + 1} ${fmtClock(turn.timestamp)} · ${[turn.provider, turn.model].filter(Boolean).join("/")} · ${fmtDurationMs(duration)} · ${turn.tokens?.input ?? 0} in / ${turn.tokens?.output ?? 0} out${
                failed ? " · failed" : retried ? ` · ${turn.routing.attempts.length} attempt(s)` : ""
              }${cacheMiss ? " · no cache" : ""}`}
              className="group relative flex shrink-0 items-end rounded-sm outline-offset-2"
              style={{ width: barWidth }}
            >
              <span
                className={cn(
                  "w-full rounded-[2px] transition-transform group-hover:-translate-y-0.5",
                  failed ? "bg-red-500/80" : retried ? "bg-amber-500/80" : "bg-emerald-500/75",
                  active && "ring-2 ring-brand-500"
                )}
                style={{ height }}
              />
              {spike ? <span className="absolute -top-1 left-0 h-[2px] w-full rounded-full bg-warning" /> : null}
              {cacheMiss ? <span className="absolute -bottom-1 left-0 h-[2px] w-full rounded-full bg-amber-600/80" /> : null}
            </button>
          );
        })}
        {liveEntry ? (
          <span
            className="mb-0.5 shrink-0 animate-pulse rounded-[2px] bg-sky-500/70"
            style={{ width: barWidth, height: 30 }}
            title="live exchange"
          />
        ) : null}
        {count === 0 && !liveEntry ? (
          <span className="pb-2 font-mono text-[10px] text-text-subtle">no exchanges yet</span>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-text-subtle">
        {liveEntry ? "live" : activeIndex !== null && activeIndex !== undefined ? `#${activeIndex + 1}` : count}
      </span>
    </div>
  );
}

/* ------------------------------- rich text -------------------------------- */

function splitCodeFences(text) {
  const parts = [];
  const regex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push({ type: "text", text: text.slice(last, match.index) });
    parts.push({ type: "code", lang: match[1], text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

function highlightParts(text, query) {
  if (!query) return [text];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts = [];
  let cursor = 0;
  for (;;) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(text.slice(found, found + needle.length));
    cursor = found + needle.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function renderInline(text, keyPrefix, query) {
  const tokens = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      return (
        <code key={key} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.88em] text-text-main">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return (
        <strong key={key} className="font-semibold text-text-main">
          {token.slice(2, -2)}
        </strong>
      );
    }
    const parts = highlightParts(token, query);
    if (parts.length === 1) return <span key={key}>{token}</span>;
    return (
      <span key={key}>
        {parts.map((part, partIndex) => (
          <mark key={partIndex} className={partIndex % 2 === 1 ? "session-find" : undefined}>
            {part}
          </mark>
        ))}
      </span>
    );
  });
}

function TextLines({ text, query }) {
  const nodes = [];
  let list = null;
  const flush = () => {
    if (list?.items.length) {
      const Tag = list.type === "ol" ? "ol" : "ul";
      nodes.push(
        <Tag
          key={`list-${nodes.length}`}
          className={cn("space-y-0.5 pl-4", list.type === "ol" ? "list-decimal" : "list-disc")}
        >
          {list.items}
        </Tag>
      );
    }
    list = null;
  };

  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      const type = numbered ? "ol" : "ul";
      if (!list || list.type !== type) {
        flush();
        list = { type, items: [] };
      }
      list.items.push(<li key={`li-${index}`}>{renderInline((bullet || numbered)[1], index, query)}</li>);
      return;
    }
    flush();
    if (trimmed === "") {
      nodes.push(<span key={`sp-${index}`} className="block h-2" />);
      return;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      nodes.push(
        <p key={`h-${index}`} className="pt-1 font-semibold text-text-main">
          {renderInline(heading[2], index, query)}
        </p>
      );
      return;
    }
    nodes.push(
      <p key={`p-${index}`} className="whitespace-pre-wrap [text-wrap:pretty]">
        {renderInline(line, index, query)}
      </p>
    );
  });
  flush();
  return <div className="flex flex-col gap-0.5">{nodes}</div>;
}

export function RichText({ text, query = null }) {
  const blocks = useMemo(() => splitCodeFences(text || ""), [text]);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-lg border border-border-subtle bg-bg p-3 font-mono text-[11px] leading-relaxed text-text-main"
          >
            <code>{block.text.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <TextLines key={index} text={block.text} query={query} />
        )
      )}
    </div>
  );
}
