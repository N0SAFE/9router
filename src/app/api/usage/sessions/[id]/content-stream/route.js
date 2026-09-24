import {
  getDetailsByImplicitKey,
  getDetailsByLiveKey,
  getDetailsBySession,
  getRecentDetailRows,
} from "@/lib/db/index.js";
import {
  buildSessionTurns,
  groupImplicitSessions,
  implicitKeyFromSessionId,
} from "@/lib/usage/sessions";
import { getLiveTurns, liveContentEmitter } from "@/lib/usage/liveContent";
import { listLiveRequests } from "@/lib/usage/liveRouting";
import { detectContextProblem } from "@/lib/usage/routingEvents";

export const dynamic = "force-dynamic";

async function resolveSession(sessionId) {
  if (!sessionId) return { sessionId: null, liveKey: null, details: [] };
  if (sessionId.startsWith("implicit:")) {
    const implicitKey = implicitKeyFromSessionId(sessionId);
    const indexed = implicitKey ? await getDetailsByImplicitKey(implicitKey, 1000) : [];
    const indexedMatch = groupImplicitSessions(indexed).find((group) => group.id === sessionId);
    if (indexedMatch) {
      return { sessionId: null, liveKey: indexedMatch.liveKey || null, details: indexedMatch.details };
    }
    const recent = await getRecentDetailRows(1000);
    const match = groupImplicitSessions(recent).find((group) => group.id === sessionId);
    return { sessionId: null, liveKey: match?.liveKey || null, details: match?.details || [] };
  }
  if (sessionId.startsWith("live:")) {
    const liveKey = sessionId.slice("live:".length);
    const indexed = await getDetailsByLiveKey(liveKey, 1000);
    const indexedMatch = groupImplicitSessions(indexed).find((group) => group.liveKey === liveKey);
    if (indexedMatch) return { sessionId: null, liveKey, details: indexedMatch.details };
    const recent = await getRecentDetailRows(1000);
    const match = groupImplicitSessions(recent).find((group) => group.liveKey === liveKey);
    return { sessionId: null, liveKey, details: match?.details || [] };
  }
  const details = await getDetailsBySession(sessionId, 1000);
  return { sessionId, liveKey: null, details };
}

function pastContentFrom(details) {
  return buildSessionTurns(details).map((turn) => ({
    index: turn.index,
    userMessages: turn.userMessages,
    toolMessages: turn.toolMessages,
    assistant: turn.assistant,
    toolCalls: turn.toolCalls,
  }));
}

function createRoutingLookup() {
  let map = new Map();
  let builtAt = 0;
  return () => {
    const now = Date.now();
    // Content deltas are coalesced, but several sessions can still be open at
    // once. Reuse the routing map briefly instead of rebuilding it per frame.
    if (now - builtAt >= 250) {
      map = new Map(listLiveRequests().map((entry) => [entry.id, entry]));
      builtAt = now;
    }
    return map;
  };
}

function liveContentFrom(session, routingLookup) {
  // Attach the live routing trace so the chat can explain a slow or retried
  // request while it is still running (phase, attempts, fallbacks, errors).
  const routingById = routingLookup();
  return getLiveTurns({ sessionId: session.sessionId, liveKey: session.liveKey }).map((entry) => {
    const live = routingById.get(entry.requestId) || null;
    const attempts = Array.isArray(live?.attempts) ? live.attempts : [];
    return {
      requestId: entry.requestId,
      userText: entry.userText,
      assistant: entry.assistant,
      thinking: entry.thinking,
      toolCalls: entry.toolCalls,
      status: entry.status,
      phase: entry.phase || (entry.status === "streaming" ? "routing" : entry.status),
      error: entry.error || null,
      model: entry.model,
      provider: entry.provider,
      startedAt: entry.startedAt,
      firstDeltaAt: entry.firstDeltaAt || null,
      finishedAt: entry.finishedAt || null,
      routing: live
        ? {
            status: live.status,
            events: (live.events || []).slice(-8),
            attempts,
            combo: live.combo || null,
            contextProblem: detectContextProblem(
              `${live.error || ""} ${attempts.map((attempt) => attempt.error || "").join(" ")}`
            ),
          }
        : null,
    };
  });
}

/**
 * GET /api/usage/sessions/[id]/content-stream
 * SSE carrying message text only: a `snapshot` with past turns plus in-flight
 * text, then `delta` frames while the model is generating. Analytics (tokens,
 * cost, latency, routing) stay on /api/usage/sessions/[id]/stream.
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id || "");
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "A session id is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const session = await resolveSession(sessionId);
      const routingLookup = createRoutingLookup();
      send("snapshot", {
        sessionId: session.sessionId,
        liveKey: session.liveKey,
        past: pastContentFrom(session.details),
        live: liveContentFrom(session, routingLookup),
      });

      let queued = false;
      let contentTimer = null;
      const onContent = (event) => {
        if (closed || queued) return;
        const entry = event?.entry;
        if (!entry) return;
        const matches =
          (session.sessionId && entry.sessionId === session.sessionId) ||
          (session.liveKey && entry.liveKey === session.liveKey);
        if (!matches) return;
        queued = true;
        // Coalesce token deltas into ~10 frames/second.
        contentTimer = setTimeout(() => {
          contentTimer = null;
          queued = false;
          if (closed) return;
          send("delta", { live: liveContentFrom(session, routingLookup) });
        }, 100);
      };
      liveContentEmitter.on("content", onContent);

      heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
          clearInterval(heartbeat);
        }
      }, 25000);

      const cleanup = () => {
        closed = true;
        liveContentEmitter.off("content", onContent);
        if (contentTimer) clearTimeout(contentTimer);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal?.addEventListener?.("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    },
  });
}
