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
import {
  eventsFromTrace,
  fallbackCount,
  isSuccessStatus,
  pairToolResults,
  turnContextProblem,
  turnDiagnostics,
} from "@/lib/usage/routingEvents";
import { fmtCompact, fmtCost } from "./format";

const VIEWS = [
  { value: "chat", label: "Chat" },
  { value: "timeline", label: "Timeline" },
];

const TIMELINE_MODES = [
  { value: "waterfall", label: "Waterfall" },
  { value: "relative", label: "Relative" },
];

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

function fmtOffset(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "+0s";
  if (ms < 60000) return `+${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `+${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function fmtDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

function fmtClock(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtTimeAgo(timestamp) {
  if (!timestamp) return "—";
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function costTone(turn, maxCost) {
  if (!turn.costUsd || !maxCost) return "bg-emerald-500/70";
  const ratio = turn.costUsd / maxCost;
  if (ratio >= 0.75) return "bg-red-500/80";
  if (ratio >= 0.4) return "bg-amber-500/80";
  return "bg-emerald-500/70";
}

function providerModel(turn) {
  const provider = turn?.provider || turn?.routing?.provider;
  const model = turn?.model || turn?.routing?.model;
  return [provider, model].filter(Boolean).join("/") || "—";
}

function SpikeIcon({ flags }) {
  if (!flags?.length) return null;
  return (
    <span
      className="material-symbols-outlined text-[14px] text-warning"
      title={flags.map((flag) => flag.message).join("\n")}
    >
      local_fire_department
    </span>
  );
}

function Avatar({ role }) {
  const isUser = role === "user";
  return (
    <span
      className={cn(
        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ring-1",
        isUser ? "bg-primary/10 text-primary ring-primary/20" : "bg-brand-500/10 text-brand-500 ring-brand-500/20"
      )}
    >
      <span className="material-symbols-outlined text-[16px]">{isUser ? "person" : "auto_awesome"}</span>
    </span>
  );
}

/* ------------------------------ rich text -------------------------------- */

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
          className={cn("ml-4 space-y-0.5", list.type === "ol" ? "list-decimal" : "list-disc")}
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
      nodes.push(<span key={`sp-${index}`} className="block h-1.5" />);
      return;
    }
    nodes.push(
      <p key={`p-${index}`} className="whitespace-pre-wrap">
        {renderInline(line, index)}
      </p>
    );
  });
  flush();
  return <div className="flex flex-col gap-0.5">{nodes}</div>;
}

function RichText({ text }) {
  const blocks = useMemo(() => splitCodeFences(text || ""), [text]);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-2/60 p-2.5 font-mono text-[11px] leading-relaxed text-text-main"
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

/* ------------------------------ routing UI -------------------------------- */

function RoutingTrace({ events, className }) {
  if (!events?.length) {
    return <p className="rounded-lg border border-border-subtle bg-bg px-2.5 py-2 text-[11px] text-text-muted">No routing trace recorded.</p>;
  }
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg", className)}>
      {events.map((event, index) => (
        <div
          key={index}
          className={cn(
            "flex items-start gap-2 border-b border-border-subtle px-2.5 py-1.5 last:border-b-0",
            event.type === "error" && "bg-danger/5",
            event.type === "fallback" && "bg-warning/5"
          )}
        >
          <span className={cn("material-symbols-outlined mt-0.5 text-[13px]", EVENT_TONE[event.type] || "text-text-muted")}>
            {EVENT_ICON[event.type] || "info"}
          </span>
          <span className={cn("min-w-0 flex-1 break-words text-[11px]", event.type === "error" ? "text-danger" : "text-text-main")}>
            {event.message || event.type}
          </span>
          {event.status != null ? (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{event.status}</span>
          ) : null}
          {event.action ? (
            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">{event.action}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RouteChips({ turn }) {
  const trace = turn?.routing || {};
  const fallbacks = fallbackCount(trace);
  const failed = !isSuccessStatus(turn?.status);
  const context = turnContextProblem(turn);
  const account = trace.selected?.name;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {trace.combo?.name ? (
        <span className="rounded-full bg-brand-500/10 px-1.5 py-0.5 text-[9px] font-medium text-brand-500">combo {trace.combo.name}</span>
      ) : null}
      {account ? <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] text-text-muted">{account}</span> : null}
      {fallbacks > 0 ? (
        <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] text-warning">
          {fallbacks} fallback{fallbacks > 1 ? "s" : ""}
        </span>
      ) : null}
      {failed ? <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-[9px] text-danger">failed</span> : null}
      {context ? <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-[9px] text-danger">context/limit</span> : null}
    </span>
  );
}

function Metric({ icon, children, tone }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5 whitespace-nowrap", tone)}>
      {icon ? <span className="material-symbols-outlined text-[12px]">{icon}</span> : null}
      {children}
    </span>
  );
}

function TurnMetrics({ turn }) {
  if (!turn) return null;
  return (
    <>
      <Metric icon="north" tone="text-primary">
        {fmtCompact(turn.tokens.input)}
      </Metric>
      {turn.tokens.cached > 0 ? (
        <Metric icon="bolt" tone="text-sky-500">
          {fmtCompact(turn.tokens.cached)}
        </Metric>
      ) : null}
      <Metric icon="south" tone="text-emerald-600 dark:text-emerald-400">
        {fmtCompact(turn.tokens.output)}
      </Metric>
      {turn.tokens.reasoning > 0 ? <Metric icon="psychology">{fmtCompact(turn.tokens.reasoning)}</Metric> : null}
      <Metric icon="payments" tone={turn.costUsd >= 0.05 ? "text-warning" : undefined}>
        {fmtCost(turn.costUsd)}
      </Metric>
      {turn.ttft ? <Metric icon="timer">{fmtDurationMs(turn.ttft)} ttft</Metric> : null}
      {turn.total ? <Metric icon="schedule">{fmtDurationMs(turn.total)}</Metric> : null}
      {turn.outputSpeed ? <Metric icon="speed">{turn.outputSpeed.toFixed(1)} tok/s</Metric> : null}
      {turn.cacheHitRate !== null && turn.cacheHitRate !== undefined && turn.tokens.input > 0 ? (
        <Metric icon="cached">{Math.round(turn.cacheHitRate * 100)}%</Metric>
      ) : null}
      {turn.toolCalls?.length ? (
        <Metric icon="build" tone="text-brand-500">
          {turn.toolCalls.length}
        </Metric>
      ) : null}
    </>
  );
}

function ThinkingBlock({ text, streaming = false, durationMs = null }) {
  if (!text) return null;
  const label = streaming
    ? "thinking…"
    : durationMs && durationMs > 400
      ? `thought for ${(durationMs / 1000).toFixed(1)}s`
      : "thinking";
  return (
    <details className="group mb-1.5 rounded-xl border border-border-subtle bg-surface-2/40 px-3 py-2" open={streaming}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-text-muted">
        <span className={cn("material-symbols-outlined text-[13px]", streaming ? "animate-pulse text-brand-500" : "")}>
          psychology
        </span>
        {label}
        <span className="material-symbols-outlined ml-auto text-[14px] transition-transform group-open:rotate-180">expand_more</span>
      </summary>
      <p className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-2.5 text-[11.5px] italic leading-relaxed text-text-muted">
        {text}
      </p>
    </details>
  );
}

function prettyJson(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function looksLikeToolError(text) {
  return typeof text === "string" && /(^|\b)(error|failed|exception|denied|timeout|not found)(\b|:)/i.test(text.slice(0, 400));
}

function ToolCallCards({ calls = [], toolMessages = [], streaming = false }) {
  const paired = useMemo(() => pairToolResults(calls, toolMessages), [calls, toolMessages]);
  if (!paired.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {paired.map((call, index) => {
        const args = prettyJson(call.arguments);
        const failed = looksLikeToolError(call.result);
        return (
          <details key={`${call.name}-${index}`} className="group overflow-hidden rounded-lg border border-border-subtle bg-bg">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
              <span className={cn("material-symbols-outlined text-[14px]", failed ? "text-danger" : "text-brand-500")}>
                {streaming ? "build_circle" : failed ? "report" : "build"}
              </span>
              <span className="shrink-0 font-mono text-[11px] font-medium text-text-main">{call.name || "tool"}</span>
              {args ? (
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-subtle">
                  {args.replace(/\s+/g, " ").slice(0, 140)}
                </span>
              ) : null}
              {call.result ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-0.5 text-[9px]",
                    failed ? "bg-danger/10 text-danger" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  )}
                >
                  {failed ? "error" : "result"}
                </span>
              ) : null}
              <span className="material-symbols-outlined text-[14px] text-text-subtle transition-transform group-open:rotate-180">
                expand_more
              </span>
            </summary>
            <div className="flex flex-col gap-1.5 border-t border-border-subtle bg-surface-2/30 px-2.5 py-2">
              {args ? (
                <div>
                  <p className="mb-0.5 text-[9px] uppercase tracking-wide text-text-muted">arguments</p>
                  <pre className="max-h-48 overflow-auto rounded-md bg-bg p-2 font-mono text-[10px] leading-relaxed text-text-main">{args}</pre>
                </div>
              ) : null}
              {call.result ? (
                <div>
                  <p className="mb-0.5 text-[9px] uppercase tracking-wide text-text-muted">result</p>
                  <pre
                    className={cn(
                      "max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-bg p-2 font-mono text-[10px] leading-relaxed",
                      failed ? "text-danger" : "text-text-main"
                    )}
                  >
                    {call.result}
                  </pre>
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // clipboard unavailable
        }
      }}
      className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 transition-colors hover:bg-surface-2", copied ? "text-emerald-500" : "text-text-subtle")}
    >
      <span className="material-symbols-outlined text-[12px]">{copied ? "check" : "content_copy"}</span>
      {copied ? "copied" : "copy"}
    </button>
  );
}

/* -------------------------------- chat ----------------------------------- */

function Shimmer() {
  return (
    <span className="flex flex-col gap-1.5">
      {[92, 78, 58].map((width, index) => (
        <span key={index} className="block h-2.5 animate-pulse rounded-full bg-surface-2" style={{ width: `${width}%` }} />
      ))}
    </span>
  );
}

function LiveStatus({ entry, now }) {
  if (!entry) return null;
  const elapsed = Math.max(0, (now || entry.startedAt) - entry.startedAt);
  const phase = entry.phase || "routing";
  const label =
    phase === "routing"
      ? "routing…"
      : phase === "thinking"
        ? "thinking…"
        : phase === "writing"
          ? "writing…"
          : phase === "done"
            ? "finalising…"
            : phase;
  const events = (entry.routing?.events || []).filter((event) =>
    ["attempt", "fallback", "error", "account", "pool", "combo"].includes(event.type)
  );
  const interesting = events.slice(-3);
  const problem = entry.routing?.contextProblem || phase === "error";

  return (
    <div className="mb-1.5 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5",
            problem ? "bg-danger/10 text-danger" : "bg-sky-500/10 text-sky-600 dark:text-sky-400"
          )}
        >
          <span className="material-symbols-outlined animate-spin text-[11px]">progress_activity</span>
          {label}
        </span>
        <span>{fmtDurationMs(elapsed)} elapsed</span>
        {entry.provider || entry.model ? (
          <span className="font-mono">{[entry.provider, entry.model].filter(Boolean).join("/")}</span>
        ) : null}
        {entry.routing?.combo ? (
          <span className="rounded-full bg-brand-500/10 px-1.5 py-0.5 text-brand-500">combo {entry.routing.combo}</span>
        ) : null}
        {entry.routing?.contextProblem ? <span className="text-danger">context/limit</span> : null}
      </div>
      {interesting.length ? (
        <div className="flex flex-col gap-0.5 rounded-lg border border-border-subtle bg-bg px-2 py-1.5">
          {interesting.map((event, index) => (
            <span
              key={index}
              className={cn(
                "flex items-start gap-1.5 text-[10px]",
                event.type === "error"
                  ? "text-danger"
                  : event.type === "fallback" || event.type === "attempt"
                    ? "text-warning"
                    : "text-text-muted"
              )}
            >
              <span className="material-symbols-outlined text-[12px]">{EVENT_ICON[event.type] || "info"}</span>
              <span className="min-w-0 flex-1 break-words">{event.message || event.type}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Diagnostics({ turn }) {
  const notes = useMemo(() => turnDiagnostics(turn), [turn]);
  const [expanded, setExpanded] = useState(false);
  if (!notes.length) return null;
  const visible = expanded ? notes : notes.filter((note) => note.level !== "info");
  const hidden = notes.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((note, index) => (
        <span
          key={index}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px]",
            note.level === "error"
              ? "bg-danger/10 text-danger"
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
        <button type="button" onClick={() => setExpanded((value) => !value)} className="text-[9.5px] text-primary">
          +{hidden} more
        </button>
      ) : expanded && notes.length > visible.length ? (
        <button type="button" onClick={() => setExpanded(false)} className="text-[9.5px] text-primary">
          less
        </button>
      ) : null}
    </div>
  );
}

function UserBubble({ text, at }) {
  return (
    <div className="flex items-start justify-end gap-2.5">
      <div className="flex min-w-0 max-w-[80%] flex-col items-end gap-1">
        <div className="rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-text-main ring-1 ring-primary/15">
          <RichText text={text} />
        </div>
        {at ? <span className="pr-1 text-[10px] text-text-subtle">{fmtClock(at)}</span> : null}
      </div>
      <Avatar role="user" />
    </div>
  );
}

function AssistantMessage({ turn, past, liveEntry, routeOpen, onToggleRoute, now }) {
  const assistant = past?.assistant || turn?.assistant;
  const toolCalls = past?.toolCalls || turn?.toolCalls;
  const toolMessages = past?.toolMessages || turn?.toolMessages;
  const content = assistant?.content;
  const streaming = Boolean(liveEntry) && liveEntry.status === "streaming";
  const headerModel = turn ? providerModel(turn) : [liveEntry?.provider, liveEntry?.model].filter(Boolean).join("/");
  const at = turn?.timestamp || liveEntry?.startedAt;
  const thinkingMs = turn
    ? turn.ttft
    : liveEntry
      ? (liveEntry.phase === "thinking" ? (now || liveEntry.startedAt) : liveEntry.firstDeltaAt || liveEntry.startedAt) - liveEntry.startedAt
      : null;

  return (
    <div className="flex items-start gap-2.5">
      <Avatar role="assistant" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-subtle">
          <span className="font-medium text-text-muted">{headerModel || "assistant"}</span>
          {turn ? <RouteChips turn={turn} /> : null}
          {turn?.flags?.length ? <SpikeIcon flags={turn.flags} /> : null}
          {streaming ? (
            <span className="inline-flex items-center gap-1 text-sky-500">
              <span className="material-symbols-outlined animate-spin text-[12px]">progress_activity</span>
              streaming
            </span>
          ) : null}
          <span className="ml-auto">{fmtClock(at)}</span>
        </div>

        {liveEntry ? <LiveStatus entry={liveEntry} now={now} /> : null}

        <ThinkingBlock text={assistant?.thinking} streaming={streaming && liveEntry?.phase === "thinking"} durationMs={thinkingMs} />

        <div className="rounded-2xl rounded-tl-md border border-border-subtle bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-text-main">
          {content ? (
            <>
              <RichText text={content} />
              {streaming ? (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-sky-500 align-middle" />
              ) : null}
            </>
          ) : streaming ? (
            <Shimmer />
          ) : (
            <span className="italic text-text-muted">
              {turn?.status && !isSuccessStatus(turn.status) ? `(${turn.status})` : "(no content recorded)"}
            </span>
          )}
          <ToolCallCards calls={toolCalls} toolMessages={toolMessages} streaming={streaming} />
        </div>

        {toolMessages?.length && !toolCalls?.length ? (
          <div className="flex flex-col gap-0.5 rounded-lg border border-border-subtle bg-surface-2/40 px-2.5 py-1.5 font-mono text-[10px] text-text-muted">
            {toolMessages.map((message, index) => (
              <p key={`tool-${index}`} className="truncate" title={message.text || ""}>
                {message.text || "(tool result)"}
              </p>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-muted">
          {turn ? <TurnMetrics turn={turn} /> : null}
          {turn ? (
            <button
              type="button"
              onClick={onToggleRoute}
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 transition-colors hover:bg-surface-2",
                routeOpen ? "text-primary" : "text-text-subtle"
              )}
            >
              <span className="material-symbols-outlined text-[12px]">route</span>
              route
            </button>
          ) : null}
          {content ? <CopyButton text={content} /> : null}
        </div>

        {turn ? <Diagnostics turn={turn} /> : null}

        {routeOpen && turn ? <RoutingTrace events={eventsFromTrace(turn)} /> : null}
      </div>
    </div>
  );
}

function ChatView({ session, turns, content, spikeIds, openRoutes, onToggleRoute, follow, setFollow, bottomRef, now }) {
  const liveTurns = useMemo(() => {
    const entries = content?.live || [];
    return entries.filter((entry) => {
      // An in-flight turn is never hidden: it is the live view.
      if (!entry.finishedAt) return true;
      // A persisted row only replaces the live turn once it carries real
      // content — the placeholder row written at stream start does not.
      return !turns.some((turn) => {
        if (turn.assistant?.content === "[Streaming in progress...]") return false;
        if (turn.routing?.liveId && turn.routing.liveId === entry.requestId) return true;
        const at = new Date(turn.timestamp || 0).getTime();
        return Number.isFinite(at) && at > 0 && Math.abs(at - entry.startedAt) < 5000;
      });
    });
  }, [content, turns]);

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg">
      <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-2/30 px-3 py-1.5">
        <span className="material-symbols-outlined text-[15px] text-text-muted">forum</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Conversation</span>
        <span className="text-[10px] text-text-subtle">
          {turns.length} turn(s)
          {liveTurns.length > 0 ? ` · ${liveTurns.length} generating` : ""}
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-text-muted">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          follow
        </label>
      </div>

      <div className="flex max-h-[620px] min-h-[280px] flex-col gap-5 overflow-y-auto px-3 py-4">
        {turns.filter((turn) => {
          // The row persisted at stream start is a placeholder; the live bubble
          // below shows the same turn with its real, streaming content.
          if (turn.assistant?.content !== "[Streaming in progress...]") return true;
          const at = new Date(turn.timestamp || 0).getTime();
          return !(content?.live || []).some((entry) => Math.abs(at - entry.startedAt) < 15000);
        }).map((turn) => {
          const past = content?.past?.find((entry) => entry.index === turn.index);
          const userMessages = past?.userMessages || turn.userMessages;
          return (
            <div key={turn.id || turn.index} className={cn("flex flex-col gap-3", spikeIds.has(turn.id) && "rounded-xl bg-warning/5 p-2")}>
              {userMessages?.length ? (
                userMessages.map((message, index) => (
                  <UserBubble key={`user-${index}`} text={message.text || (message.redacted ? "(content hidden)" : "")} at={turn.timestamp} />
                ))
              ) : (
                <div className="flex items-start justify-end gap-2.5">
                  <span className="rounded-2xl rounded-br-md bg-surface-2 px-3 py-1.5 text-[11px] italic text-text-muted">
                    follow-up turn — no new user message
                  </span>
                  <Avatar role="user" />
                </div>
              )}
              <AssistantMessage
                turn={turn}
                past={past}
                routeOpen={Boolean(openRoutes[turn.id || `turn-${turn.index}`])}
                onToggleRoute={() => onToggleRoute(turn.id || `turn-${turn.index}`)}
                now={now}
              />
            </div>
          );
        })}

        {liveTurns.map((entry) => (
          <div key={entry.requestId} className="flex flex-col gap-3">
            {entry.userText ? <UserBubble text={entry.userText} at={entry.startedAt} /> : null}
            <AssistantMessage
              liveEntry={entry}
              past={{ assistant: { content: entry.assistant, thinking: entry.thinking }, toolCalls: entry.toolCalls }}
              routeOpen={false}
              onToggleRoute={() => {}}
              now={now}
            />
          </div>
        ))}

        {turns.length === 0 && liveTurns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="material-symbols-outlined text-[26px] text-text-subtle">chat_bubble</span>
            <p className="text-sm text-text-main">Nothing to show yet</p>
            <p className="max-w-sm text-xs text-text-muted">
              Messages appear here as the session streams. Analytics (tokens, cost, routing) fill in when each turn completes.
            </p>
          </div>
        ) : null}

        {session.generating && liveTurns.length === 0 ? (
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <span className="material-symbols-outlined animate-spin text-[13px] text-sky-500">progress_activity</span>
            generating the next turn…
          </div>
        ) : null}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/* ------------------------------- timeline -------------------------------- */

function TimelineView({
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
}) {
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const nowMs = now;
  const liveStart = liveEntry?.startedAt || null;
  const liveOffset = liveStart && timeline ? Math.max(0, liveStart - timeline.startMs) : null;

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-surface-2/30 px-2.5 py-1.5">
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
          <span className="material-symbols-outlined text-[14px]">waterfall_chart</span>
          Waterfall
          <span className="normal-case tracking-normal text-text-subtle">
            span {fmtDurationMs(timeline?.span)} · active {fmtDurationMs(timeline?.activeTotal)}
          </span>
        </span>
        <SegmentedControl options={TIMELINE_MODES} value={timelineMode} onChange={setTimelineMode} size="sm" />
      </div>

      {timeline?.mostlyIdle && timelineMode === "waterfall" ? (
        <p className="border-b border-border-subtle bg-warning/5 px-2.5 py-1 text-[10px] text-warning">
          Turns are spread over a long window — switch to Relative to compare durations.
        </p>
      ) : null}

      <div className="flex items-center gap-2 border-b border-border-subtle bg-bg/60 px-2.5 py-1 text-[9px] text-text-subtle">
        <span className="w-36 shrink-0">turn · started</span>
        <span className="relative h-3.5 min-w-0 flex-1">
          {ticks.map((fraction, index) => (
            <span key={fraction} className="absolute top-0 h-3.5 border-l border-border/70" style={{ left: `${fraction * 100}%` }}>
              <span
                className={cn(
                  "absolute top-0 whitespace-nowrap pl-1",
                  index === ticks.length - 1 && "-translate-x-full pl-0 pr-1"
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
        <span className="w-56 shrink-0 text-right">metrics</span>
      </div>

      <div className="max-h-[560px] min-w-0 overflow-y-auto">
        {turns.map((turn, position) => {
          const startedMs = new Date(turn.timestamp || 0).getTime() || timeline?.startMs || 0;
          const offset = Math.max(0, startedMs - (timeline?.startMs || 0));
          const duration = turn.total || 0;
          const prefill = Math.min(turn.ttft || 0, duration);
          const denominator = timelineMode === "relative" ? timeline?.maxTurnDuration || 1 : timeline?.span || 1;
          const leftPct = timelineMode === "relative" ? 0 : (offset / denominator) * 100;
          const widthPct = Math.max(0.35, (duration / denominator) * 100);
          const failed = !isSuccessStatus(turn.status);
          const toolCount = turn.toolCalls?.length || 0;
          const previous = turns[position - 1];
          const previousEnd = previous
            ? Math.max(0, new Date(previous.timestamp || 0).getTime() - (timeline?.startMs || 0) + (previous.total || 0))
            : 0;
          const gapMs = position > 0 ? Math.max(0, offset - previousEnd) : 0;
          const gapPct = timelineMode === "waterfall" ? (gapMs / (timeline?.span || 1)) * 100 : 0;
          const key = turn.id || `turn-${turn.index}`;

          return (
            <div key={key} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                onClick={() => setExpandedTurn((current) => (current === key ? null : key))}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2/50",
                  spikeIds.has(turn.id) && "bg-warning/5"
                )}
              >
                <span className="flex w-36 shrink-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      failed ? "bg-danger" : turn.status === "success" || !turn.status ? "bg-emerald-500" : "bg-warning"
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[10px] text-text-main">
                      #{turn.index + 1} · {fmtClock(turn.timestamp)}
                    </span>
                    <span className="block truncate text-[9px] text-text-subtle">
                      {timelineMode === "relative" ? fmtDurationMs(duration) : fmtOffset(offset)}
                      {turn.provider || turn.model ? ` · ${turn.provider || ""}/${turn.model || ""}` : ""}
                    </span>
                  </span>
                </span>

                <span className="relative h-6 min-w-0 flex-1">
                  {[0.2, 0.4, 0.6, 0.8].map((fraction) => (
                    <span key={fraction} className="absolute inset-y-0 border-l border-border/30" style={{ left: `${fraction * 100}%` }} />
                  ))}
                  {gapPct > 4 ? (
                    <span
                      className="absolute inset-y-2 rounded-full border border-dashed border-border"
                      style={{ left: `${(previousEnd / (timeline?.span || 1)) * 100}%`, width: `${gapPct}%` }}
                      title={`idle ${fmtDurationMs(gapMs)}`}
                    />
                  ) : null}
                  <span className="absolute inset-y-0" style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 3 }}>
                    <span
                      className="absolute inset-y-1.5 left-0 right-0 flex overflow-hidden rounded-[3px] ring-1 ring-inset ring-black/5"
                      title={`#${turn.index + 1} ${providerModel(turn)} · ${fmtDurationMs(duration)} · TTFT ${turn.ttft ? `${turn.ttft}ms` : "—"} · ${turn.tokens.input} in / ${turn.tokens.output} out · ${fmtCost(turn.costUsd)}${toolCount ? ` · ${toolCount} tool call(s)` : ""}`}
                    >
                      {failed ? (
                        <span className="h-full w-full bg-red-500/80" />
                      ) : (
                        <>
                          <span className="h-full bg-cyan-500/70" style={{ width: `${duration > 0 ? (prefill / duration) * 100 : 0}%` }} />
                          <span className={cn("h-full flex-1", costTone(turn, maxCost))} />
                        </>
                      )}
                    </span>
                    {spikeIds.has(turn.id) ? (
                      <span
                        className="absolute -top-1 left-1/2 -translate-x-1/2 text-[11px] leading-none"
                        title={turn.flags?.map((flag) => flag.message).join("\n")}
                      >
                        🔥
                      </span>
                    ) : null}
                    {toolCount > 0 ? (
                      <span className="absolute -bottom-0.5 left-0 flex gap-0.5">
                        {Array.from({ length: Math.min(toolCount, 6) }, (_, index) => (
                          <span key={index} className="size-1.5 rounded-full bg-amber-500 ring-1 ring-bg" />
                        ))}
                      </span>
                    ) : null}
                  </span>
                </span>

                <span className="flex w-56 shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-right text-[10px] text-text-muted">
                  <TurnMetrics turn={turn} />
                </span>
              </button>

              {expandedTurn === key ? (
                <div className="flex flex-col gap-2 border-t border-border-subtle bg-surface-2/30 p-2.5">
                  <div className="grid gap-2 text-[11px] text-text-muted sm:grid-cols-2">
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase tracking-wide">Model</p>
                      <p className="truncate font-mono text-text-main">{providerModel(turn)}</p>
                      {turn.connectionName ? <p className="truncate">account {turn.connectionName}</p> : null}
                      {turn.routeSummary ? <p className="truncate">{turn.routeSummary}</p> : null}
                      {turn.flags?.map((flag) => (
                        <p key={flag.code} className="text-warning">
                          {flag.message}
                        </p>
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
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <p className="text-[10px] uppercase tracking-wide text-text-muted">Diagnostics</p>
                    <Diagnostics turn={turn} />
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Routing</p>
                    <RoutingTrace events={eventsFromTrace(turn)} />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        {session.generating && liveEntry ? (
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="flex w-36 shrink-0 items-center gap-1.5">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" />
              <span className="min-w-0">
                <span className="block font-mono text-[10px] text-sky-500">#{turns.length + 1} · now</span>
                <span className="block text-[9px] text-text-subtle">{fmtClock(liveStart)}</span>
              </span>
            </span>
            <span className="relative h-6 min-w-0 flex-1">
              <span
                className="absolute inset-y-1.5 animate-pulse rounded-[3px] bg-sky-500/40 ring-1 ring-inset ring-sky-500/40"
                style={{
                  left: `${timelineMode === "relative" ? 0 : ((liveOffset || 0) / (timeline?.span || 1)) * 100}%`,
                  width: `${Math.max(0.5, ((nowMs - (liveStart || nowMs)) / (timelineMode === "relative" ? timeline?.maxTurnDuration || 1 : timeline?.span || 1)) * 100)}%`,
                }}
              />
            </span>
            <span className="w-56 shrink-0 text-right text-[10px] text-sky-500">generating…</span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle px-2.5 py-1 text-[10px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-cyan-500/70" /> prefill (TTFT)
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
          <span className="inline-block h-2 w-3 rounded-sm border border-dashed border-border" /> idle gap
        </span>
        <span className="ml-auto">bar = duration · colour = cost vs session max</span>
      </div>
    </div>
  );
}

/* --------------------------------- shell --------------------------------- */

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedTurn, setExpandedTurn] = useState(null);
  const [openRoutes, setOpenRoutes] = useState({});
  const [budgetDraft, setBudgetDraft] = useState({ cost: "", tokens: "" });
  const [content, setContent] = useState(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(() => Date.now());
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
      setSelectedId((current) => requestedSession || current || payload.sessions?.[0]?.id || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [query, requestedSession]);

  useEffect(() => {
    // Initial load + refresh when the search changes (live sessions appear fast).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshList();
    const timer = setInterval(refreshList, 5000);
    return () => clearInterval(timer);
  }, [refreshList]);

  useEffect(() => {
    // Deep link from the routing canvas: ?tab=sessions&session=<id>
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requestedSession) setSelectedId(requestedSession);
  }, [requestedSession]);

  // Streamed session detail (SSE) — snapshot then live updates.
  useEffect(() => {
    if (!selectedId) return undefined;
    // Reset the view when switching sessions.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(null);
    setExpandedTurn(null);
    setOpenRoutes({});
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

  // Message text streams on its own channel so the chat renders while the model
  // is still generating (analytics arrive only when a turn finishes).
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
    if (follow && bottomRef.current) {
      bottomRef.current.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [session, content, follow, view]);

  useEffect(() => {
    if (!session?.live && !session?.generating) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.live, session?.generating]);

  const turns = useMemo(() => session?.turns || [], [session]);
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

  const timeline = useMemo(() => {
    if (turns.length === 0) return null;
    const starts = turns
      .map((turn) => new Date(turn.timestamp || 0).getTime())
      .filter((value) => Number.isFinite(value) && value > 0);
    const startMs = starts.length > 0 ? Math.min(...starts) : 0;
    const endMs = Math.max(
      ...turns.map((turn) => (new Date(turn.timestamp || 0).getTime() || startMs) + (turn.total || 0))
    );
    const span = Math.max(1, endMs - startMs);
    const activeTotal = turns.reduce((sum, turn) => sum + (turn.total || 0), 0);
    const maxTurnDuration = Math.max(1, ...turns.map((turn) => turn.total || 0));
    return { startMs, endMs, span, activeTotal, maxTurnDuration, mostlyIdle: span > Math.max(120000, activeTotal * 12) };
  }, [turns]);

  const liveEntry = useMemo(() => (content?.live || []).find((entry) => entry.status === "streaming") || null, [content]);
  const routing = session?.routing || null;
  const selectedSummary = session?.summary || null;
  const budget = session?.budget || null;

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

  const toggleRoute = useCallback((key) => {
    setOpenRoutes((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          <span className="material-symbols-outlined text-[18px]">forum</span>
          Sessions
        </span>
        <span className="text-[11px] text-text-muted">
          conversations with streamed chat, per-turn analytics and the routing decisions behind every reply
        </span>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
        {/* Session list */}
        <Card padding="sm" className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-text-subtle">All sessions</span>
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

          <div className="flex max-h-[620px] flex-col divide-y divide-border-subtle overflow-y-auto">
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
                    {entry.generating ? (
                      <span className="material-symbols-outlined animate-spin text-[12px] text-sky-500" title="generating now">
                        progress_activity
                      </span>
                    ) : entry.live ? (
                      <span className="size-1.5 rounded-full bg-emerald-500" title="live" />
                    ) : null}
                    {entry.monitored ? <span className="material-symbols-outlined text-[13px] text-brand-500">visibility</span> : null}
                    {entry.budgetExceeded ? <span className="material-symbols-outlined text-[13px] text-danger">battery_alert</span> : null}
                    <span className="truncate text-xs font-medium text-text-main">{entry.label || entry.id}</span>
                  </span>
                  <span className="flex items-center gap-2 pl-0.5 text-[10px] text-text-muted">
                    <span className="truncate">{entry.model || "—"}</span>
                    <span>{entry.requests} req</span>
                    <span>{fmtCompact(entry.tokens)} tok</span>
                    <span>{fmtCost(entry.costUsd)}</span>
                    {entry.failures > 0 ? <span className="text-danger">{entry.failures} failed</span> : null}
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
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-text-main">{selectedSummary?.label || session.id}</h3>
                    {session.live ? (
                      <Badge variant="success" size="sm" dot>
                        live
                      </Badge>
                    ) : null}
                    {session.generating ? (
                      <Badge variant="info" size="sm">
                        generating…
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
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                    <span>{selectedSummary?.requests} request(s)</span>
                    <span>{fmtCompact(selectedSummary?.tokens || 0)} tokens</span>
                    <span>{fmtCost(selectedSummary?.costUsd || 0)}</span>
                    {selectedSummary?.models?.length ? <span className="truncate">{selectedSummary.models.join(", ")}</span> : null}
                    {session.spikes?.flagged?.length ? (
                      <span className="text-warning">{session.spikes.flagged.length} spike(s)</span>
                    ) : null}
                    {session.spikes?.tokenMedian ? <span>median {fmtCompact(session.spikes.tokenMedian)} tok</span> : null}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl options={VIEWS} value={view} onChange={setView} size="sm" />
                  <Button size="sm" variant="outline" icon={live ? "pause" : "play_arrow"} onClick={() => setLive((value) => !value)}>
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

              {/* Routing rollup */}
              {routing ? (
                <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-border-subtle bg-bg px-2.5 py-1.5 text-[10px]">
                  <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-text-muted">
                    <span className="material-symbols-outlined text-[13px]">route</span>
                    route
                  </span>
                  {routing.providers.map((provider) => (
                    <span key={provider.name} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-text-main">
                      {provider.name} <span className="text-text-subtle">×{provider.count}</span>
                    </span>
                  ))}
                  {routing.accounts.map((account) => (
                    <span key={account.name} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-text-muted">
                      {account.name} <span className="text-text-subtle">×{account.count}</span>
                    </span>
                  ))}
                  {routing.combos.map((combo) => (
                    <span key={combo.name} className="rounded-full bg-brand-500/10 px-1.5 py-0.5 font-medium text-brand-500">
                      combo {combo.name}
                    </span>
                  ))}
                  {selectedSummary?.tokens ? (
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-text-muted">
                      cache {Math.round(((selectedSummary.cachedTokens || 0) / selectedSummary.tokens) * 100)}%
                    </span>
                  ) : null}
                  {routing.fallbacks > 0 ? (
                    <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-warning">{routing.fallbacks} fallback(s)</span>
                  ) : null}
                  {routing.attempts > 0 ? (
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-text-subtle">{routing.attempts} attempt(s)</span>
                  ) : null}
                  {routing.errors > 0 ? <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-danger">{routing.errors} failed</span> : null}
                  {routing.contextProblems > 0 ? (
                    <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-danger">{routing.contextProblems} context/limit</span>
                  ) : null}
                </div>
              ) : null}

              {/* Spend & budget (collapsible) */}
              <details className="group rounded-[10px] border border-border-subtle bg-bg">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  <span className="material-symbols-outlined text-[14px]">trending_up</span>
                  Spend &amp; budget
                  <span className="normal-case tracking-normal text-text-subtle">
                    {fmtCost(selectedSummary?.costUsd || 0)} · {fmtCompact(selectedSummary?.tokens || 0)} tok
                    {budget?.costPct !== null && budget?.costPct !== undefined ? ` · ${budget.costPct.toFixed(0)}% of budget` : ""}
                  </span>
                  <span className="material-symbols-outlined ml-auto text-[14px] transition-transform group-open:rotate-180">expand_more</span>
                </summary>
                <div className="grid min-w-0 gap-3 border-t border-border-subtle p-2.5 lg:grid-cols-[minmax(0,1fr)_minmax(220px,260px)]">
                  <div className="min-w-0 rounded-[10px] border border-border-subtle bg-surface p-2.5">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Cumulative spend</span>
                      <button
                        type="button"
                        className="text-[10px] text-primary"
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
                    <div className="h-[120px] w-full min-w-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                          <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="var(--color-text-muted)" />
                          <YAxis
                            tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
                            tick={{ fontSize: 9 }}
                            stroke="var(--color-text-muted)"
                            width={46}
                          />
                          <ChartTooltip
                            contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 11 }}
                            formatter={(value, name) => [
                              name === "cost" ? `$${Number(value).toFixed(4)}` : Number(value).toLocaleString(),
                              name === "cost" ? "cumulative $" : "cumulative tokens",
                            ]}
                          />
                          <Area type="monotone" dataKey="cost" stroke="#f59e0b" fill="#f59e0b33" strokeWidth={2} />
                          {session.monitor?.budgetUsd ? (
                            <ReferenceLine
                              y={session.monitor.budgetUsd}
                              stroke="#ef4444"
                              strokeDasharray="4 4"
                              label={{ value: "budget", fontSize: 9, fill: "#ef4444" }}
                            />
                          ) : null}
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-border-subtle bg-surface p-2.5 text-[11px] text-text-muted">
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
              </details>

              {/* Chat / Timeline */}
              <div className="min-w-0">
                {view === "chat" ? (
                  <ChatView
                    session={session}
                    turns={turns}
                    content={content}
                    spikeIds={spikeIds}
                    openRoutes={openRoutes}
                    onToggleRoute={toggleRoute}
                    follow={follow}
                    setFollow={setFollow}
                    bottomRef={bottomRef}
                    now={now}
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

              <div className="flex flex-wrap items-center gap-3 text-[10px] text-text-muted">
                <span>
                  stream: {live ? "SSE (analytics + content)" : "paused"} · {turns.length} turn(s) · active{" "}
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
