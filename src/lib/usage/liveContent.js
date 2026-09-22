/**
 * Live content registry: streams what a session is actually saying.
 *
 * Analytics (tokens, cost, latency, routing) travel on their own session stream
 * once a request finishes; this registry carries the message text while it is
 * still being generated, so the Chat view renders the reply as it streams
 * instead of waiting for the first completed turn.
 */

import { EventEmitter } from "events";
import { detailsEmitter } from "@/lib/db/index.js";

const globalStore = globalThis;
if (!globalStore._liveContent) {
  globalStore._liveContent = { map: new Map(), emitter: new EventEmitter() };
  globalStore._liveContent.emitter.setMaxListeners(200);
}

const turns = globalStore._liveContent.map;
export const liveContentEmitter = globalStore._liveContent.emitter;

const KEEP_MS = 10 * 60 * 1000;
const MAX_TURNS_PER_SESSION = 40;
const MAX_TEXT = 400_000;

function prune(now = Date.now()) {
  for (const [id, entry] of turns) {
    if (now - entry.lastEventAt > KEEP_MS) {
      turns.delete(id);
    }
  }
}

function clip(text) {
  if (typeof text !== "string") return "";
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

export function startLiveTurn({ requestId, sessionId = null, liveKey = null, model = null, provider = null, userText = null } = {}) {
  if (!requestId) return null;
  prune();
  const entry = {
    requestId,
    sessionId,
    liveKey,
    model: model || null,
    provider: provider || null,
    userText: userText ? clip(userText) : null,
    assistant: "",
    thinking: "",
    toolCalls: [],
    status: "streaming",
    phase: "routing",
    firstDeltaAt: null,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
  };
  turns.set(requestId, entry);
  liveContentEmitter.emit("content", { type: "start", entry });
  return entry;
}

export function pushContentDelta(requestId, { text = "", thinking = "", toolCalls = null } = {}) {
  const entry = turns.get(requestId);
  if (!entry) return null;
  if (!entry.firstDeltaAt && (text || thinking)) entry.firstDeltaAt = Date.now();
  if (text) {
    entry.assistant = clip(entry.assistant + text);
    entry.phase = "writing";
  }
  if (thinking) {
    entry.thinking = clip(entry.thinking + thinking);
    if (!text) entry.phase = "thinking";
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    // Provider deltas stream tool calls in fragments (name once, then argument
    // chunks): merge by index so the live view can render them as they build up.
    const byIndex = new Map((entry.toolCalls || []).map((call, index) => [call.index ?? index, call]));
    for (const call of toolCalls) {
      const index = call?.index ?? byIndex.size;
      const existing = byIndex.get(index) || { name: null, arguments: "" };
      byIndex.set(index, {
        name: call?.name || existing.name || null,
        arguments: `${existing.arguments || ""}${call?.arguments || ""}`,
      });
    }
    entry.toolCalls = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .slice(-20);
  }
  entry.lastEventAt = Date.now();
  liveContentEmitter.emit("content", { type: "delta", entry });
  return entry;
}

export function finishContentTurn(requestId, { status = "completed", error = null } = {}) {
  const entry = turns.get(requestId);
  if (!entry) return null;
  entry.status = status;
  entry.phase = status === "completed" ? "done" : status;
  entry.error = error ? String(error) : null;
  entry.finishedAt = Date.now();
  entry.lastEventAt = Date.now();
  liveContentEmitter.emit("content", { type: "finish", entry });
  return entry;
}

/** Live turns for a session (explicit id or loose key), oldest first. */
export function getLiveTurns({ sessionId = null, liveKey = null } = {}) {
  prune();
  return [...turns.values()]
    .filter((entry) => (sessionId && entry.sessionId === sessionId) || (liveKey && entry.liveKey === liveKey))
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-MAX_TURNS_PER_SESSION);
}

// A persisted detail means the turn is done: stop showing it as streaming.
detailsEmitter.on("detail", (record) => {
  // The placeholder row is written when the stream starts: the turn is not done.
  if (record?.streaming) return;
  const now = Date.now();
  for (const entry of turns.values()) {
    if (entry.finishedAt) continue;
    const matches =
      (record?.sessionId && entry.sessionId === record.sessionId) ||
      (record?.liveKey && entry.liveKey === record.liveKey);
    if (matches) {
      entry.status = "completed";
      entry.finishedAt = now;
      entry.lastEventAt = now;
      liveContentEmitter.emit("content", { type: "finish", entry });
    }
  }
});

export function listLiveContent() {
  prune();
  return [...turns.values()].sort((a, b) => a.startedAt - b.startedAt);
}
