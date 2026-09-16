"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Input } from "@/shared/components";
import { chatRuntime } from "./chatRuntime";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

function shortId(value) {
  return typeof value === "string" && value.length > 10 ? value.slice(0, 8) : value || "—";
}

function formatMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

function modelLabel(model) {
  if (model.kind === "combo") {
    return model.id;
  }
  const bare = String(model.id).includes("/") ? String(model.id).slice(String(model.id).indexOf("/") + 1) : model.id;
  return model.name && model.name !== model.id ? model.name : bare;
}

const ROUTING_ACTIONS = {
  fallback: { label: "fallback", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  capability: { label: "capability", className: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
  "non-fallback": { label: "returned", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  cooldown: { label: "cooldown", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
};

/** Minimal, XSS-safe markdown renderer (code fences, headings, lists, inline marks). */
function renderInline(text, keyPrefix) {
  const nodes = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.85em] text-brand-500">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch && /^https?:\/\//i.test(linkMatch[2])) {
        nodes.push(
          <a key={key} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" className="text-brand-500 underline">
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function Markdown({ text }) {
  const blocks = useMemo(() => {
    const result = [];
    const fence = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    let index = 0;
    while ((match = fence.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: "text", value: text.slice(lastIndex, match.index), key: `t${index++}` });
      }
      result.push({ type: "code", language: match[1], value: match[2], key: `c${index++}` });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push({ type: "text", value: text.slice(lastIndex), key: `t${index++}` });
    }
    return result;
  }, [text]);

  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed">
      {blocks.map((block) => {
        if (block.type === "code") {
          return (
            <div key={block.key} className="overflow-hidden rounded-lg border border-border bg-surface-3/60">
              {block.language ? (
                <div className="border-b border-border px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted">
                  {block.language}
                </div>
              ) : null}
              <pre className="overflow-x-auto p-3 font-mono text-xs text-text-main">
                <code>{block.value.trimEnd()}</code>
              </pre>
            </div>
          );
        }
        return (
          <div key={block.key} className="flex flex-col gap-1.5">
            {block.value.split("\n").map((line, lineIndex) => {
              const trimmed = line.trim();
              if (!trimmed) {
                return <span key={lineIndex} className="h-1" />;
              }
              if (/^#{1,3}\s/.test(trimmed)) {
                const level = trimmed.match(/^#+/)[0].length;
                const content = trimmed.replace(/^#+\s/, "");
                return (
                  <p key={lineIndex} className={level === 1 ? "text-base font-semibold" : "text-sm font-semibold"}>
                    {renderInline(content, `${block.key}-h${lineIndex}`)}
                  </p>
                );
              }
              if (/^[-*]\s/.test(trimmed)) {
                return (
                  <div key={lineIndex} className="flex gap-2 pl-1">
                    <span className="text-brand-500">•</span>
                    <span>{renderInline(trimmed.replace(/^[-*]\s/, ""), `${block.key}-l${lineIndex}`)}</span>
                  </div>
                );
              }
              return <p key={lineIndex}>{renderInline(line, `${block.key}-p${lineIndex}`)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}

function Chip({ children, className = "" }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${className || "bg-surface-3 text-text-muted"}`}>
      {children}
    </span>
  );
}

function usageNumbers(run) {
  const tokens = run?.tokens || {};
  const prompt = tokens.prompt_tokens ?? tokens.input_tokens ?? null;
  const completion = tokens.completion_tokens ?? tokens.output_tokens ?? null;
  const cached = tokens.cached_tokens ?? tokens.cache_read_input_tokens ?? null;
  const cachePercent = Number.isFinite(prompt) && prompt > 0 && Number.isFinite(cached)
    ? Math.round((cached / prompt) * 100)
    : null;
  const seconds = Number.isFinite(run?.latency?.total) && run.latency.total > 0 ? run.latency.total / 1000 : null;
  const tokensPerSecond = seconds && Number.isFinite(completion) ? Math.round(completion / seconds) : null;
  return { prompt, completion, cached, cachePercent, tokensPerSecond };
}

function buildSteps(run) {
  if (!run) {
    return [];
  }
  const steps = [];
  const { prompt, cached, cachePercent, tokensPerSecond, completion } = usageNumbers(run);
  const trace = run.routing || {};
  const saver = trace.tokenSaver || {};

  steps.push({
    key: "request",
    icon: "send",
    title: "Request",
    detail: `${prompt != null ? `${formatNumber(prompt)} prompt tokens` : "prompt sent"}${cached ? ` · ${formatNumber(cached)} cached (${cachePercent}%)` : ""}`,
  });

  const saverParts = [];
  if (saver.headroom) {
    saverParts.push(
      `headroom (${saver.headroom.mode || "compress"}): ${formatNumber(saver.headroom.tokensBefore)} → ${formatNumber(saver.headroom.tokensAfter)} tokens (saved ${formatNumber(saver.headroom.tokensSaved)})`
    );
  }
  if (saver.rtk) {
    saverParts.push(`rtk: ${formatNumber(saver.rtk.bytesBefore)} → ${formatNumber(saver.rtk.bytesAfter)} bytes (${saver.rtk.hits} hits)`);
  }
  if (saver.pxpipe) {
    saverParts.push(`pxpipe: ${saver.pxpipe.applied ? `${saver.pxpipe.images ?? 0} image(s)` : "not applied"}`);
  }
  if (saverParts.length > 0) {
    steps.push({ key: "compress", icon: "compress", title: "Token savers", detail: saverParts.join(" · ") });
  }

  if (trace.combo) {
    steps.push({
      key: "combo",
      icon: "layers",
      title: `Combo · ${trace.combo.name}`,
      detail: (trace.combo.models || []).map((model) => `${model.model}: ${model.status}`).join(" → ") || "no members tried",
    });
  }

  if (trace.selected) {
    steps.push({
      key: "account",
      icon: "key",
      title: `Account · ${trace.selected.name || shortId(trace.selected.connectionId)}`,
      detail: trace.selected.reason ? `selected by ${trace.selected.reason}` : "selected",
    });
  }

  const attempts = Array.isArray(trace.attempts) ? trace.attempts : [];
  if (attempts.length > 0) {
    steps.push({
      key: "fallback",
      icon: "route",
      title: `${attempts.length} fallback attempt${attempts.length === 1 ? "" : "s"}`,
      detail: attempts
        .map((attempt) => `${attempt.name || shortId(attempt.connectionId)} ${attempt.status ?? ""} ${attempt.action ?? ""}`.trim())
        .join(" · "),
    });
  }

  steps.push({
    key: "response",
    icon: "flag",
    title: "Response",
    detail: `${formatMs(run.latency?.ttft)} TTFT · ${formatMs(run.latency?.total)} total${completion != null ? ` · ${formatNumber(completion)} out` : ""}${tokensPerSecond ? ` · ${tokensPerSecond} tok/s` : ""}`,
  });

  return steps;
}

function RoutingCard({ run }) {
  if (!run) {
    return null;
  }
  const { cachePercent, tokensPerSecond, completion, prompt } = usageNumbers(run);
  const trace = run.routing || {};
  const attempts = Array.isArray(trace.attempts) ? trace.attempts : [];

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-surface-2/50 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip className={run.status === "success" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-red-500/10 text-red-600 dark:text-red-400"}>
          <span className={`h-1.5 w-1.5 rounded-full ${run.status === "success" ? "bg-green-500" : "bg-red-500"}`} />
          {run.status || "done"}
        </Chip>
        {trace.combo ? <Chip className="bg-brand-500/10 text-brand-500">combo · {trace.combo.name}</Chip> : <Chip>single model</Chip>}
        <Chip>{run.provider || "—"}</Chip>
        <Chip>{run.model || "—"}</Chip>
        {trace.selected?.reason ? <Chip className="bg-blue-500/10 text-blue-600 dark:text-blue-400">pick: {trace.selected.reason}</Chip> : null}
        {cachePercent != null ? <Chip className="bg-purple-500/10 text-purple-600 dark:text-purple-400">cache {cachePercent}%</Chip> : null}
        {trace.tokenSaver?.headroom?.tokensSaved ? (
          <Chip className="bg-green-500/10 text-green-600 dark:text-green-400">−{formatNumber(trace.tokenSaver.headroom.tokensSaved)} tokens</Chip>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-text-muted sm:grid-cols-4">
        <span>
          Account <span className="text-text-main">{trace.selected?.name || shortId(run.connectionId)}</span>
        </span>
        <span>
          TTFT <span className="text-text-main">{formatMs(run.latency?.ttft)}</span>
        </span>
        <span>
          Total <span className="text-text-main">{formatMs(run.latency?.total)}</span>
        </span>
        <span>
          Tokens <span className="text-text-main">{formatNumber(prompt)}→{formatNumber(completion)}</span>
          {tokensPerSecond ? <span className="text-text-muted"> · {tokensPerSecond}/s</span> : null}
        </span>
      </div>

      {attempts.length > 0 ? (
        <div className="flex flex-col gap-1">
          {attempts.map((attempt, index) => (
            <div key={`${attempt.connectionId}-${index}`} className="flex flex-wrap items-center gap-1.5">
              <span className="text-text-muted">#{index + 1}</span>
              <span>{attempt.name || shortId(attempt.connectionId)}</span>
              {attempt.status ? <Chip className="bg-surface-3">HTTP {attempt.status}</Chip> : null}
              {attempt.action ? (
                <Chip className={ROUTING_ACTIONS[attempt.action]?.className || "bg-surface-3 text-text-muted"}>
                  {ROUTING_ACTIONS[attempt.action]?.label || attempt.action}
                </Chip>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RuntimeDetails({ run }) {
  const steps = useMemo(() => buildSteps(run), [run]);
  if (!run) {
    return <p className="text-xs text-text-muted">Send a message to inspect the routing trace here.</p>;
  }
  const { prompt, completion, cachePercent, tokensPerSecond } = usageNumbers(run);
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap gap-1.5">
        <Chip>{run.provider || "—"}</Chip>
        <Chip>{run.model || "—"}</Chip>
        <Chip>account {shortId(run.connectionId)}</Chip>
        {run.routing?.combo?.name ? <Chip className="bg-brand-500/10 text-brand-500">combo · {run.routing.combo.name}</Chip> : null}
      </div>

      <div className="flex flex-col gap-2">
        {steps.map((step) => (
          <div key={step.key} className="flex gap-2">
            <span className="material-symbols-outlined mt-0.5 text-[16px] text-brand-500">{step.icon}</span>
            <div className="min-w-0">
              <p className="font-medium text-text-main">{step.title}</p>
              <p className="break-words text-text-muted">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border bg-surface-2/50 p-2">
          <p className="text-text-muted">Prompt</p>
          <p className="text-sm font-semibold">{formatNumber(prompt)}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface-2/50 p-2">
          <p className="text-text-muted">Completion</p>
          <p className="text-sm font-semibold">{formatNumber(completion)}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface-2/50 p-2">
          <p className="text-text-muted">Cache</p>
          <p className="text-sm font-semibold">{cachePercent != null ? `${cachePercent}%` : "—"}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface-2/50 p-2">
          <p className="text-text-muted">Speed</p>
          <p className="text-sm font-semibold">{tokensPerSecond ? `${tokensPerSecond} tok/s` : "—"}</p>
        </div>
      </div>

      <details open>
        <summary className="cursor-pointer text-text-muted">Raw trace</summary>
        <pre className="mt-1 max-h-80 overflow-auto rounded-lg border border-border bg-surface-3/60 p-2 font-mono text-[10px] text-text-main">
          {JSON.stringify(run.routing || run, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export default function BasicChatPageClient() {
  const snapshot = useSyncExternalStore(chatRuntime.subscribe, chatRuntime.getState, chatRuntime.getState);
  const [input, setInput] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [showModels, setShowModels] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState("");
  const scrollRef = useRef(null);
  const { copy } = useCopyToClipboard();

  useEffect(() => {
    chatRuntime.init();
  }, []);

  const { sessions, activeSessionId, models, modelId } = snapshot;
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const messages = useMemo(() => activeSession?.messages || [], [activeSession]);
  const streaming = messages.some((message) => message.streaming);
  const activeModel = useMemo(() => models.find((model) => model.id === modelId) || null, [models, modelId]);

  const lastRoutedMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant" && message.routing) || null,
    [messages]
  );
  const detailMessage = useMemo(
    () => messages.find((message) => message.id === selectedMessageId && message.role === "assistant" && message.routing) || lastRoutedMessage,
    [messages, selectedMessageId, lastRoutedMessage]
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const groupedModels = useMemo(() => {
    const groups = new Map();
    for (const model of models) {
      const key = model.kind === "combo" ? "combo" : model.owned_by || "other";
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: model.kind === "combo" ? "Combos" : model.provider_name || key,
          isCombo: model.kind === "combo",
          models: [],
        });
      }
      groups.get(key).models.push(model);
    }
    return [...groups.values()].sort((a, b) => (a.isCombo !== b.isCombo ? (a.isCombo ? -1 : 1) : a.label.localeCompare(b.label)));
  }, [models]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || !modelId) {
      return;
    }
    setInput("");
    void chatRuntime.send(text);
  }, [input, modelId]);

  return (
    <div className="flex h-full min-h-0 w-full gap-4 p-4 lg:p-6">
      {/* Sessions + models */}
      <aside className={`${showModels ? "flex" : "hidden"} w-full flex-col gap-3 lg:flex lg:w-72 lg:shrink-0`}>
        <Button icon="add" onClick={() => chatRuntime.newSession()} className="w-full">
          New chat
        </Button>
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-1/60 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Model</span>
            {activeModel?.kind === "combo" ? <Chip className="bg-brand-500/10 text-brand-500">combo</Chip> : null}
            {activeModel?.free ? <Chip className="bg-green-500/10 text-green-600 dark:text-green-400">free</Chip> : null}
          </div>
          <Input
            placeholder="Search models…"
            value={modelSearch}
            onChange={(event) => setModelSearch(event.target.value.toLowerCase())}
          />
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1 custom-scrollbar">
            {groupedModels
              .filter((group) => !modelSearch.trim() || group.models.some((model) => String(model.id).toLowerCase().includes(modelSearch) || String(model.name || "").toLowerCase().includes(modelSearch)))
              .map((group) => (
                <div key={group.key} className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{group.label}</span>
                  {group.models
                    .filter((model) => !modelSearch.trim() || String(model.id).toLowerCase().includes(modelSearch) || String(model.name || "").toLowerCase().includes(modelSearch))
                    .map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => chatRuntime.setModel(model.id)}
                        className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                          modelId === model.id ? "bg-brand-500/15 text-brand-500" : "hover:bg-surface-2 text-text-main"
                        }`}
                      >
                        <span className="min-w-0 truncate">{modelLabel(model)}</span>
                        {model.free ? <span className="shrink-0 text-[10px] text-green-500">free</span> : null}
                      </button>
                    ))}
                </div>
              ))}
            {groupedModels.length === 0 ? <p className="text-xs text-text-muted">No models available.</p> : null}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-surface-1/60 p-2 custom-scrollbar">
          <span className="px-1 py-1 text-xs font-semibold uppercase tracking-wide text-text-muted">History</span>
          {sessions.length === 0 ? <p className="px-1 text-xs text-text-muted">No conversations yet.</p> : null}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => chatRuntime.selectSession(session.id)}
              className={`flex flex-col rounded-lg px-2 py-1.5 text-left transition-colors ${
                session.id === activeSessionId ? "bg-brand-500/15" : "hover:bg-surface-2"
              }`}
            >
              <span className="truncate text-xs font-medium text-text-main">{session.title || "New chat"}</span>
              <span className="truncate text-[10px] text-text-muted">{session.model || "—"}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Chat */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface-1/60">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Chat</h1>
            <p className="truncate text-xs text-text-muted">
              {activeModel ? `${activeModel.provider_name || activeModel.owned_by} · ${modelLabel(activeModel)}` : "Pick a model"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" icon="list" className="lg:hidden" onClick={() => setShowModels((value) => !value)}>
              Models
            </Button>
            {streaming ? (
              <Button size="sm" variant="danger" icon="stop" onClick={() => chatRuntime.stop(activeSession?.id)}>
                Stop
              </Button>
            ) : null}
          </div>
        </header>

        <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 custom-scrollbar">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <span className="material-symbols-outlined text-4xl text-brand-500">forum</span>
              <p className="text-sm font-medium">Ask anything</p>
              <p className="max-w-sm text-xs text-text-muted">
                Every answer shows the real routing: provider, account, combo fallbacks, token savers, cache, tokens and latency.
              </p>
            </div>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                  message.role === "user" ? "bg-brand-500 text-white" : "border border-border bg-surface-2/70 text-text-main"
                }`}
              >
                {message.role === "user" ? (
                  <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                ) : (
                  <>
                    {message.content ? <Markdown text={message.content} /> : null}
                    {message.streaming && !message.content ? (
                      <span className="flex items-center gap-1 text-text-muted">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 [animation-delay:120ms]" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 [animation-delay:240ms]" />
                      </span>
                    ) : null}
                    {message.error ? <p className="mt-2 text-xs text-red-500">{message.error}</p> : null}
                  </>
                )}
              </div>
              {message.role === "assistant" && message.routing ? (
                <button type="button" className="w-full max-w-[85%] text-left" onClick={() => setSelectedMessageId(message.id)}>
                  <RoutingCard run={message.routing} />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Send a message… (Enter to send, Shift+Enter for a new line)"
              className="max-h-40 min-h-[42px] flex-1 resize-y rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm text-text-main outline-none focus:border-brand-500/50"
            />
            <Button icon="send" onClick={send} loading={streaming} disabled={!input.trim() || !modelId}>
              Send
            </Button>
          </div>
        </div>
      </section>

      {/* Run details */}
      <aside className="hidden w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-surface-1/60 p-4 xl:flex custom-scrollbar">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Run details</h2>
          {detailMessage ? (
            <Button size="sm" variant="ghost" icon="content_copy" onClick={() => copy(JSON.stringify(detailMessage.routing, null, 2))}>
              Copy
            </Button>
          ) : null}
        </div>
        <RuntimeDetails run={detailMessage?.routing || null} />
      </aside>
    </div>
  );
}
