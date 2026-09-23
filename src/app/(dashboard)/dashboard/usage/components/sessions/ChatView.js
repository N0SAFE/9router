"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import {
  eventsFromTrace as fromTrace,
  fallbackCount,
  isSuccessStatus,
  looksLikeToolError,
  pairToolResults,
  turnContextProblem,
} from "@/lib/usage/routingEvents";
import { fmtCompact, fmtCost } from "../format";
import { Avatar, MicroLabel, PHASES, RailNode, RichText, Shimmer, fmtClock, fmtDurationMs, providerModel } from "./primitives";
import DiagnosticsPanel from "./DiagnosticsPanel";
import RoutingTracePanel from "./RoutingTracePanel";
import TurnMetrics from "./TurnMetrics";

const VISIBLE_TURNS = 120;
const CONTEXT_PREFIX = /^\s*(?:<([a-z_][a-z0-9_]*)>[\s\S]*?<\/\1>\s*)+/i;

/* ------------------------------ message atoms ----------------------------- */

function UserText({ text }) {
  const value = String(text || "");
  const match = CONTEXT_PREFIX.exec(value);
  if (!match) return <RichText text={value} />;
  const context = match[0].trim();
  const rest = value.slice(match[0].length).trim();
  return (
    <div className="flex flex-col gap-2">
      <details className="rounded-lg border border-border-subtle bg-bg/60 px-2.5 py-1.5">
        <summary className="cursor-pointer list-none">
          <MicroLabel>context · {context.length.toLocaleString()} chars</MicroLabel>
        </summary>
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-text-muted">
          {context}
        </pre>
      </details>
      {rest ? <RichText text={rest} /> : null}
    </div>
  );
}

function UserBubble({ text, at }) {
  return (
    <div className="flex items-end justify-end gap-2.5">
      <div className="flex min-w-0 max-w-[76%] flex-col items-end gap-1">
        <div className="rounded-2xl rounded-br-sm bg-brand-500/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-text-main ring-1 ring-brand-500/15">
          <UserText text={text} />
        </div>
        {at ? <MicroLabel className="pr-1 normal-case tracking-normal">{fmtClock(at)}</MicroLabel> : null}
      </div>
      <Avatar role="user" />
    </div>
  );
}

function ToolResultRow({ messages }) {
  return (
    <div className="ml-9 flex max-w-[78%] flex-col gap-1 rounded-xl border border-border-subtle bg-surface-2/40 px-3 py-2">
      <span className="flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[12px] text-text-subtle">terminal</span>
        <MicroLabel>tool result{messages.length > 1 ? "s" : ""}</MicroLabel>
      </span>
      {messages.map((message, index) => (
        <p key={index} className="truncate font-mono text-[10.5px] leading-relaxed text-text-muted" title={message.text || ""}>
          {message.text || "(empty)"}
        </p>
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
        <span className="rounded-md bg-brand-500/10 px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-brand-600 dark:text-brand-400">
          {trace.combo.name}
        </span>
      ) : null}
      {account ? (
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-text-muted">{account}</span>
      ) : null}
      {fallbacks > 0 ? (
        <span className="rounded-md bg-warning/10 px-1.5 py-0.5 font-mono text-[9.5px] text-warning" title="fallback attempts before this reply">
          ↻{fallbacks}
        </span>
      ) : null}
      {failed ? <span className="rounded-md bg-danger/10 px-1.5 py-0.5 font-mono text-[9.5px] text-danger">failed</span> : null}
      {context ? (
        <span className="rounded-md bg-danger/10 px-1.5 py-0.5 font-mono text-[9.5px] text-danger" title="context/limit error">
          ctx
        </span>
      ) : null}
    </span>
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
    <details className="group rounded-xl border border-border-subtle bg-surface-2/40 px-3 py-2" open={streaming}>
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <span className={cn("material-symbols-outlined text-[13px]", streaming ? "animate-pulse text-brand-500" : "text-text-subtle")}>
          psychology
        </span>
        <MicroLabel className="normal-case tracking-normal text-[10.5px] text-text-muted">{label}</MicroLabel>
        <span className="material-symbols-outlined ml-auto text-[14px] text-text-subtle transition-transform group-open:rotate-180">
          expand_more
        </span>
      </summary>
      <p className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-[11.5px] italic leading-relaxed text-text-muted">
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

function ToolCallCards({ calls = [], toolMessages = [], streaming = false }) {
  const paired = useMemo(() => (toolMessages?.length ? pairToolResults(calls, toolMessages) : calls), [calls, toolMessages]);
  if (!paired.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {paired.map((call, index) => {
        const args = prettyJson(call.arguments);
        const failed = call.resultIsError ?? looksLikeToolError(call.result);
        return (
          <details key={`${call.name}-${index}`} className="group overflow-hidden rounded-xl border border-border-subtle bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
              <span className={cn("material-symbols-outlined text-[14px]", failed ? "text-danger" : "text-brand-500")}>
                {streaming ? "build_circle" : failed ? "report" : "build"}
              </span>
              <span className="shrink-0 font-mono text-[11px] font-medium text-text-main">{call.name || "tool"}</span>
              {args ? (
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text-subtle">
                  {args.replace(/\s+/g, " ").slice(0, 150)}
                </span>
              ) : null}
              {call.result ? (
                <span
                  className={cn(
                    "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[9.5px]",
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
            <div className="flex flex-col gap-2 border-t border-border-subtle bg-bg/60 px-3 py-2.5">
              {args ? (
                <div>
                  <MicroLabel>arguments</MicroLabel>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-text-main">
                    {args}
                  </pre>
                </div>
              ) : null}
              {call.result ? (
                <div>
                  <MicroLabel>result</MicroLabel>
                  <pre
                    className={cn(
                      "mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-2.5 py-2 font-mono text-[10.5px] leading-relaxed",
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
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-text-subtle transition-colors hover:bg-surface-2 hover:text-text-muted"
    >
      <span className="material-symbols-outlined text-[12px]">{copied ? "check" : "content_copy"}</span>
      {copied ? "copied" : "copy"}
    </button>
  );
}

function LiveStatus({ entry, now }) {
  if (!entry) return null;
  const elapsed = Math.max(0, (now || entry.startedAt) - entry.startedAt);
  const phase = PHASES[entry.phase] ? entry.phase : "routing";
  const meta = PHASES[phase];
  const events = (entry.routing?.events || []).filter((event) =>
    ["attempt", "fallback", "error", "account", "pool", "combo"].includes(event.type)
  );
  const interesting = events.slice(-2);
  const problem = entry.routing?.contextProblem || entry.phase === "error";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
        <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5", problem ? "bg-danger/10 text-danger" : "bg-sky-500/10", !problem && meta.tone)}>
          <span className={cn("size-1.5 animate-pulse rounded-full", problem ? "bg-danger" : meta.dot)} />
          {meta.label}…
        </span>
        <span className="tabular-nums text-text-subtle">{fmtDurationMs(elapsed)}</span>
        {entry.routing?.combo ? <span className="text-brand-500">{entry.routing.combo}</span> : null}
        {entry.routing?.contextProblem ? <span className="text-danger">context/limit</span> : null}
      </div>
      {interesting.length ? (
        <div className="flex flex-col gap-0.5 border-l border-border pl-2.5">
          {interesting.map((event, index) => (
            <span
              key={index}
              className={cn(
                "truncate font-mono text-[10px]",
                event.type === "error" ? "text-danger" : event.type === "fallback" || event.type === "attempt" ? "text-warning" : "text-text-subtle"
              )}
            >
              {event.message || event.type}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessage({ turn, past, liveEntry, routeOpen, onToggleRoute, now, maxCost, statusTone }) {
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
  const hasToolCalls = Boolean(toolCalls?.length);

  return (
    <div className="flex items-start gap-2.5">
      <Avatar role="assistant" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10.5px] font-medium text-text-muted">{headerModel || "assistant"}</span>
          {turn ? <RouteChips turn={turn} /> : null}
          {turn?.flags?.length ? (
            <span
              className="material-symbols-outlined text-[13px] text-warning"
              title={turn.flags.map((flag) => flag.message).join("\n")}
            >
              local_fire_department
            </span>
          ) : null}
          <span className={cn("ml-auto font-mono text-[10px] tabular-nums", statusTone || "text-text-subtle")}>{fmtClock(at)}</span>
        </div>

        {liveEntry ? <LiveStatus entry={liveEntry} now={now} /> : null}
        <ThinkingBlock text={assistant?.thinking} streaming={streaming && liveEntry?.phase === "thinking"} durationMs={thinkingMs} />

        {content || streaming || !hasToolCalls ? (
          <div className="rounded-2xl rounded-tl-sm border border-border-subtle bg-surface px-4 py-3 text-[13.5px] leading-[1.7] text-text-main">
            {content ? (
              <>
                <RichText text={content} />
                {streaming ? (
                  <span className="ml-0.5 inline-block h-3.5 w-[3px] animate-pulse rounded-full bg-sky-500 align-middle" />
                ) : null}
              </>
            ) : streaming ? (
              <Shimmer />
            ) : (
              <span className="font-mono text-[11px] text-text-subtle">
                {turn?.status && !isSuccessStatus(turn.status) ? `(${turn.status})` : "no content recorded"}
              </span>
            )}
            {hasToolCalls ? <div className="mt-2.5"><ToolCallCards calls={toolCalls} toolMessages={toolMessages} streaming={streaming} /></div> : null}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <MicroLabel>requested {toolCalls.length} tool call{toolCalls.length > 1 ? "s" : ""}</MicroLabel>
            <ToolCallCards calls={toolCalls} toolMessages={toolMessages} streaming={streaming} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-text-muted">
          {turn ? <TurnMetrics turn={turn} /> : null}
          {turn ? (
            <button
              type="button"
              onClick={onToggleRoute}
              className={cn(
                "rounded-md px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:bg-surface-2",
                routeOpen ? "text-brand-500" : "text-text-subtle"
              )}
            >
              route
            </button>
          ) : null}
          {content ? <CopyButton text={content} /> : null}
        </div>

        {turn ? <DiagnosticsPanel turn={turn} /> : null}
        {routeOpen && turn ? <RoutingTracePanel events={fromTrace(turn)} /> : null}
      </div>
    </div>
  );
}

/* --------------------------------- the chat ------------------------------- */

function ChatTurn({ turn, past, userMessages, toolMessages, liveEntry, openRoutes, onToggleRoute, now, maxCost, isLast }) {
  const failed = turn ? !isSuccessStatus(turn.status) : false;
  const live = Boolean(liveEntry);
  const railStatus = failed ? "error" : live ? "live" : turn?.status;

  return (
    <article className={cn("relative flex gap-3 px-4", isLast ? "pb-5 pt-3" : "py-3")}>
      {/* signal rail: one node per exchange */}
      <span className="relative flex w-4 shrink-0 justify-center" aria-hidden>
        <span className={cn("absolute top-0 w-px bg-border", isLast ? "h-6" : "h-full")} />
        <span className="relative pt-1.5">
          <RailNode
            status={railStatus === "live" ? null : railStatus}
            live={live}
            phase={liveEntry?.phase}
            turn={turn}
            maxCost={maxCost}
          />
        </span>
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {userMessages?.length
          ? userMessages.map((message, index) => (
              <UserBubble
                key={`user-${index}`}
                text={message.text || (message.redacted ? "(content hidden)" : "")}
                at={turn?.timestamp}
              />
            ))
          : null}

        {toolMessages?.length ? <ToolResultRow messages={toolMessages} /> : null}

        <AssistantMessage
          turn={turn}
          past={past}
          liveEntry={liveEntry}
          routeOpen={Boolean(turn && openRoutes[turn.id || `turn-${turn.index}`])}
          onToggleRoute={() => turn && onToggleRoute(turn.id || `turn-${turn.index}`)}
          now={now}
          maxCost={maxCost}
        />
      </div>
    </article>
  );
}

export default function ChatView({ session, turns, content, openRoutes, onToggleRoute, now, maxCost }) {
  const scrollRef = useRef(null);
  const [pinned, setPinned] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const keepScrollRef = useRef(null);

  const liveTurns = useMemo(() => {
    const entries = content?.live || [];
    return entries.filter((entry) => {
      if (!entry.finishedAt) return true;
      return !turns.some((turn) => {
        if (turn.assistant?.content === "[Streaming in progress...]") return false;
        if (turn.routing?.liveId && turn.routing.liveId === entry.requestId) return true;
        const at = new Date(turn.timestamp || 0).getTime();
        return Number.isFinite(at) && at > 0 && Math.abs(at - entry.startedAt) < 5000;
      });
    });
  }, [content, turns]);

  const hiddenCount = showAll ? 0 : Math.max(0, turns.length - VISIBLE_TURNS);
  const visibleTurns = hiddenCount > 0 ? turns.slice(hiddenCount) : turns;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance < 56;
    setPinned((current) => (current === next ? current : next));
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  // Follow new content only while the reader is already at the bottom, and
  // only ever scroll the conversation container — never the page.
  const contentVersion = `${turns.length}:${(content?.live || []).reduce(
    (sum, entry) => sum + (entry.assistant?.length || 0) + (entry.thinking?.length || 0),
    0
  )}`;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [contentVersion, pinned]);

  // Keep the reading position when earlier turns are revealed above.
  useEffect(() => {
    const el = scrollRef.current;
    const saved = keepScrollRef.current;
    if (el && saved) {
      el.scrollTop = saved.top + (el.scrollHeight - saved.height);
      keepScrollRef.current = null;
    }
  }, [showAll]);

  const expandEarlier = () => {
    const el = scrollRef.current;
    if (el) keepScrollRef.current = { top: el.scrollTop, height: el.scrollHeight };
    setShowAll(true);
  };

  return (
    <section className="relative flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-brand-lg)] border border-border bg-bg">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-4 py-2">
        <MicroLabel>conversation</MicroLabel>
        <span className="font-mono text-[10px] tabular-nums text-text-subtle">
          {turns.length} exchange{turns.length === 1 ? "" : "s"}
          {liveTurns.length > 0 ? ` · ${liveTurns.length} live` : ""}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-text-subtle">
          {pinned ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              following
            </span>
          ) : (
            <button type="button" onClick={jumpToLatest} className="inline-flex items-center gap-1 text-brand-500 hover:underline">
              <span className="material-symbols-outlined text-[12px]">south</span>
              jump to latest
            </button>
          )}
        </span>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex max-h-[min(72vh,780px)] min-h-[320px] flex-col overflow-y-auto overscroll-contain"
      >
        {hiddenCount > 0 ? (
          <div className="px-4 pb-1 pt-4">
            <button
              type="button"
              onClick={expandEarlier}
              className="w-full rounded-lg border border-dashed border-border px-3 py-2 font-mono text-[10px] text-text-muted transition-colors hover:bg-surface-2"
            >
              show {hiddenCount} earlier exchange{hiddenCount === 1 ? "" : "s"}
            </button>
          </div>
        ) : null}

        {visibleTurns.map((turn, index) => {
          const past = content?.past?.find((entry) => entry.index === turn.index);
          const isLastVisible = index === visibleTurns.length - 1 && liveTurns.length === 0;
          return (
            <ChatTurn
              key={turn.id || `turn-${turn.index}`}
              turn={turn}
              past={past}
              userMessages={past?.userMessages || turn.userMessages}
              toolMessages={past?.toolMessages || turn.toolMessages}
              openRoutes={openRoutes}
              onToggleRoute={onToggleRoute}
              now={now}
              maxCost={maxCost}
              isLast={isLastVisible}
            />
          );
        })}

        {liveTurns.map((entry, index) => (
          <ChatTurn
            key={entry.requestId}
            liveEntry={entry}
            past={{
              assistant: { content: entry.assistant, thinking: entry.thinking },
              toolCalls: entry.toolCalls,
              userMessages: entry.userText ? [{ role: "user", text: entry.userText }] : [],
            }}
            userMessages={entry.userText ? [{ role: "user", text: entry.userText }] : null}
            openRoutes={{ [entry.requestId]: false }}
            onToggleRoute={() => {}}
            now={now}
            maxCost={maxCost}
            isLast={index === liveTurns.length - 1}
          />
        ))}

        {turns.length === 0 && liveTurns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <span className="material-symbols-outlined text-[26px] text-text-subtle">forum</span>
            <p className="text-sm font-medium text-text-main">No exchanges yet</p>
            <p className="max-w-sm text-xs leading-relaxed text-text-muted">
              Send a message through 9Router with this session id and the conversation streams in here.
            </p>
          </div>
        ) : null}
      </div>

      {!pinned ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-[10px] text-text-main shadow-[var(--shadow-elevated)] transition-transform hover:-translate-y-px"
        >
          <span className="material-symbols-outlined mr-1 align-middle text-[12px]">south</span>
          jump to latest
        </button>
      ) : null}
    </section>
  );
}
