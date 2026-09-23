"use client";

import { useMemo } from "react";
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

function renderInline(text, keyPrefix) {
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
    return <span key={key}>{token}</span>;
  });
}

function TextLines({ text }) {
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
      list.items.push(<li key={`li-${index}`}>{renderInline((bullet || numbered)[1], index)}</li>);
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
          {renderInline(heading[2], index)}
        </p>
      );
      return;
    }
    nodes.push(
      <p key={`p-${index}`} className="whitespace-pre-wrap [text-wrap:pretty]">
        {renderInline(line, index)}
      </p>
    );
  });
  flush();
  return <div className="flex flex-col gap-0.5">{nodes}</div>;
}

export function RichText({ text }) {
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
          <TextLines key={index} text={block.text} />
        )
      )}
    </div>
  );
}
