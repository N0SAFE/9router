"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const STORAGE_KEY = "basic-chat.sessions.v2";
const ACTIVE_KEY = "basic-chat.active.v2";

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function loadSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

function RoutingCard({ routing, latency, tokens, provider, model, connectionId, status }) {
  if (!routing && !tokens && !latency) {
    return null;
  }
  const combo = routing?.combo;
  const attempts = Array.isArray(routing?.attempts) ? routing.attempts : [];
  const selected = routing?.selected;

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-surface-2/50 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip className={status === "success" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-red-500/10 text-red-600 dark:text-red-400"}>
          <span className={`h-1.5 w-1.5 rounded-full ${status === "success" ? "bg-green-500" : "bg-red-500"}`} />
          {status || "done"}
        </Chip>
        {combo ? (
          <Chip className="bg-brand-500/10 text-brand-500">combo · {combo.name}</Chip>
        ) : (
          <Chip>single model</Chip>
        )}
        <Chip>{provider || "—"}</Chip>
        <Chip>{model || "—"}</Chip>
        {selected?.reason ? <Chip className="bg-blue-500/10 text-blue-600 dark:text-blue-400">pick: {selected.reason}</Chip> : null}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-text-muted sm:grid-cols-4">
        <span>
          Account <span className="text-text-main">{selected?.name || shortId(connectionId)}</span>
        </span>
        <span>
          TTFT <span className="text-text-main">{formatMs(latency?.ttft)}</span>
        </span>
        <span>
          Total <span className="text-text-main">{formatMs(latency?.total)}</span>
        </span>
        <span>
          Tokens <span className="text-text-main">{formatNumber(tokens?.prompt_tokens ?? tokens?.input_tokens)}→{formatNumber(tokens?.completion_tokens ?? tokens?.output_tokens)}</span>
        </span>
      </div>

      {combo?.models?.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-text-muted">combo order:</span>
          {combo.models.map((entry, index) => (
            <Chip
              key={`${entry.model}-${index}`}
              className={
                entry.status === "success"
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : String(entry.status).startsWith("failed")
                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                    : "bg-surface-3 text-text-muted"
              }
            >
              {entry.model} · {entry.status}
            </Chip>
          ))}
        </div>
      ) : null}

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
              {attempt.cooldownMs ? <span className="text-text-muted">cooldown {formatMs(attempt.cooldownMs)}</span> : null}
              {attempt.error ? <span className="truncate text-red-500/80">{String(attempt.error).slice(0, 80)}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function BasicChatPageClient() {
  const [models, setModels] = useState([]);
  const [modelId, setModelId] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showModels, setShowModels] = useState(false);
  const [detailMessageId, setDetailMessageId] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const { copy } = useCopyToClipboard();

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const messages = useMemo(() => activeSession?.messages || [], [activeSession]);

  useEffect(() => {
    setSessions(loadSessions());
    const storedActive = localStorage.getItem(ACTIVE_KEY);
    if (storedActive) {
      setActiveSessionId(storedActive);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(ACTIVE_KEY, activeSessionId);
    }
  }, [activeSessionId]);

  useEffect(() => {
    fetch("/api/chat/models", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        const list = Array.isArray(data.data) ? data.data : [];
        setModels(list);
        if (!modelId && list.length > 0) {
          setModelId(list[0].id);
        }
      })
      .catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const groupedModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const groups = new Map();
    for (const model of models) {
      if (query && !String(model.id).toLowerCase().includes(query) && !String(model.name || "").toLowerCase().includes(query)) {
        continue;
      }
      const key = model.kind === "combo" ? "combo" : model.owned_by || "other";
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: model.kind === "combo" ? "Combos" : model.provider_name || key,
          color: model.color || null,
          textIcon: model.text_icon || (model.kind === "combo" ? "CO" : "?"),
          isCombo: model.kind === "combo",
          models: [],
        });
      }
      groups.get(key).models.push(model);
    }
    return [...groups.values()].sort((a, b) => {
      if (a.isCombo !== b.isCombo) {
        return a.isCombo ? -1 : 1;
      }
      return a.label.localeCompare(b.label);
    });
  }, [models, modelSearch]);

  const activeModel = useMemo(() => models.find((model) => model.id === modelId) || null, [models, modelId]);

  const createSession = useCallback(() => {
    const session = {
      id: createId(),
      title: "New chat",
      model: modelId,
      createdAt: Date.now(),
      messages: [],
    };
    setSessions((previous) => [session, ...previous]);
    setActiveSessionId(session.id);
    setError("");
    return session;
  }, [modelId]);

  const ensureSession = useCallback(() => {
    if (activeSession) {
      return activeSession;
    }
    return createSession();
  }, [activeSession, createSession]);

  const updateSession = useCallback((sessionId, updater) => {
    setSessions((previous) =>
      previous.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }
        const next = typeof updater === "function" ? updater(session) : { ...session, ...updater };
        return next;
      })
    );
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }
    const session = ensureSession();
    const userMessage = { id: createId(), role: "user", content: text, ts: Date.now() };
    const assistantId = createId();
    const assistantMessage = { id: assistantId, role: "assistant", content: "", streaming: true, ts: Date.now() };
    const history = [...(session.messages || []), userMessage];

    updateSession(session.id, {
      title: session.messages.length === 0 ? text.slice(0, 48) : session.title,
      model: modelId,
      messages: [...history, assistantMessage],
    });
    setInput("");
    setError("");
    setStreaming(true);
    setDetailMessageId(assistantId);

    const controller = new AbortController();
    abortRef.current = controller;
    const clientRequestId = createId();

    try {
      const response = await fetch("/api/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelId,
          messages: history.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
          metadata: { clientRequestId },
        }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let assistantText = "";
      let routing = null;

      const applyStreaming = () => {
        updateSession(session.id, (current) => ({
          ...current,
          messages: current.messages.map((message) =>
            message.id === assistantId ? { ...message, content: assistantText, routing } : message
          ),
        }));
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) {
            continue;
          }
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (currentEvent === "9router.routing") {
            routing = parsed;
            continue;
          }
          const delta =
            parsed?.choices?.[0]?.delta?.content ??
            parsed?.choices?.[0]?.message?.content ??
            (typeof parsed?.content === "string" ? parsed.content : "");
          if (typeof delta === "string" && delta) {
            assistantText += delta;
            applyStreaming();
          }
        }
      }

      updateSession(session.id, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === assistantId
            ? { ...message, content: assistantText, routing, streaming: false }
            : message
        ),
      }));
    } catch (err) {
      const aborted = err?.name === "AbortError";
      updateSession(session.id, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                streaming: false,
                error: aborted ? "Stopped" : String(err?.message || err),
              }
            : message
        ),
      }));
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }, [ensureSession, input, modelId, streaming, updateSession]);

  const detailMessage = useMemo(
    () => messages.find((message) => message.id === detailMessageId && message.role === "assistant") || null,
    [messages, detailMessageId]
  );

  return (
    <div className="flex h-full min-h-0 w-full gap-4 p-4 lg:p-6">
      {/* Sessions + models */}
      <aside className={`${showModels ? "flex" : "hidden"} w-full flex-col gap-3 lg:flex lg:w-72 lg:shrink-0`}>
        <Button icon="add" onClick={createSession} className="w-full">
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
            onChange={(event) => setModelSearch(event.target.value)}
          />
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1 custom-scrollbar">
            {groupedModels.map((group) => (
              <div key={group.key} className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{group.label}</span>
                {group.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setModelId(model.id)}
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
              onClick={() => setActiveSessionId(session.id)}
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
              <Button size="sm" variant="danger" icon="stop" onClick={stop}>
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
                Every answer shows the real routing: provider, account, combo fallbacks, tokens and latency.
              </p>
            </div>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                  message.role === "user"
                    ? "bg-brand-500 text-white"
                    : "border border-border bg-surface-2/70 text-text-main"
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
                <button type="button" className="w-full max-w-[85%] text-left" onClick={() => setDetailMessageId(message.id)}>
                  <RoutingCard
                    routing={message.routing.routing}
                    latency={message.routing.latency}
                    tokens={message.routing.tokens}
                    provider={message.routing.provider}
                    model={message.routing.model}
                    connectionId={message.routing.connectionId}
                    status={message.routing.status}
                  />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="border-t border-border p-3">
          {error ? <p className="mb-2 text-xs text-red-500">{error}</p> : null}
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
        {!detailMessage ? (
          <p className="text-xs text-text-muted">Send a message to inspect the routing trace here.</p>
        ) : (
          <div className="flex flex-col gap-3 text-xs">
            <div className="flex flex-wrap gap-1.5">
              <Chip>{detailMessage.routing?.provider || "—"}</Chip>
              <Chip>{detailMessage.routing?.model || "—"}</Chip>
              <Chip>account {shortId(detailMessage.routing?.connectionId)}</Chip>
              {detailMessage.routing?.routing?.combo?.name ? (
                <Chip className="bg-brand-500/10 text-brand-500">combo · {detailMessage.routing.routing.combo.name}</Chip>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-surface-2/50 p-2">
                <p className="text-text-muted">TTFT</p>
                <p className="text-sm font-semibold">{formatMs(detailMessage.routing?.latency?.ttft)}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface-2/50 p-2">
                <p className="text-text-muted">Total</p>
                <p className="text-sm font-semibold">{formatMs(detailMessage.routing?.latency?.total)}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface-2/50 p-2">
                <p className="text-text-muted">Prompt</p>
                <p className="text-sm font-semibold">{formatNumber(detailMessage.routing?.tokens?.prompt_tokens ?? detailMessage.routing?.tokens?.input_tokens)}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface-2/50 p-2">
                <p className="text-text-muted">Completion</p>
                <p className="text-sm font-semibold">{formatNumber(detailMessage.routing?.tokens?.completion_tokens ?? detailMessage.routing?.tokens?.output_tokens)}</p>
              </div>
            </div>
            <details open>
              <summary className="cursor-pointer text-text-muted">Raw trace</summary>
              <pre className="mt-1 max-h-80 overflow-auto rounded-lg border border-border bg-surface-3/60 p-2 font-mono text-[10px] text-text-main">
                {JSON.stringify(detailMessage.routing, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </aside>
    </div>
  );
}
