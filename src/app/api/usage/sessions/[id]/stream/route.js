import { detailsEmitter } from "@/lib/db/index.js";
import { buildSessionPayload } from "@/lib/usage/sessionPayload";
import { implicitKeyFromSessionId } from "@/lib/usage/sessions";
import { liveSessionsEmitter } from "@/lib/usage/liveSessions";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/sessions/[id]/stream
 *
 * Server-sent events for one session: an initial `snapshot`, then an `update`
 * frame whenever a new request detail lands for that session (pushed straight
 * from the details writer — no polling), plus keepalive comments.
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

      const snapshot = async () => {
        try {
          return await buildSessionPayload(sessionId, { includeContent: false });
        } catch (error) {
          return { id: sessionId, error: String(error?.message || error) };
        }
      };

      const initialPayload = await snapshot();
      const sessionImplicitKey = sessionId.startsWith("implicit:") ? implicitKeyFromSessionId(sessionId) : null;
      let sessionLiveKey = initialPayload?.liveKey || (sessionId.startsWith("live:") ? sessionId.slice("live:".length) : null);
      send("snapshot", initialPayload);

      let updateTimer = null;
      let updateInFlight = false;
      let updateQueued = false;
      const scheduleUpdate = () => {
        if (closed || updateInFlight) {
          updateQueued = true;
          return;
        }
        if (updateTimer) return;
        // Several request details can land in one tick. Rebuild once after the
        // burst instead of parsing the session once per detail.
        updateTimer = setTimeout(() => {
          updateTimer = null;
          runUpdate();
        }, 250);
      };

      const runUpdate = async () => {
        if (closed || updateInFlight) {
          updateQueued = true;
          return;
        }
        updateInFlight = true;
        try {
          const payload = await snapshot();
          if (sessionLiveKey) sessionLiveKey = payload?.liveKey || sessionLiveKey;
          if (!payload?.missing) send("update", payload);
        } finally {
          updateInFlight = false;
          if (updateQueued && !closed) {
            updateQueued = false;
            scheduleUpdate();
          }
        }
      };

      const detailMatches = (entry) => {
        if (!entry) return false;
        if (sessionId.startsWith("implicit:")) {
          if (entry.sessionId) return false;
          if (sessionImplicitKey && entry.implicitKey && entry.implicitKey !== sessionImplicitKey) return false;
          if (sessionLiveKey && entry.liveKey !== sessionLiveKey) return false;
          return true;
        }
        if (sessionId.startsWith("live:")) {
          return !entry.sessionId && entry.liveKey === (sessionLiveKey || sessionId.slice("live:".length));
        }
        return entry.sessionId === sessionId;
      };

      const onDetail = (entry) => {
        if (closed || !detailMatches(entry)) return;
        scheduleUpdate();
      };

      detailsEmitter.on("detail", onDetail);

      // A session that is still generating has no detail yet: push an update as
      // soon as its request starts so the client can attach immediately.
      const onSessionEvent = (event) => {
        if (closed) return;
        const entry = event?.session;
        if (!entry) return;
        if (sessionId.startsWith("implicit:")) {
          if (entry.sessionId) return;
          if (sessionLiveKey && entry.liveKey && entry.liveKey !== sessionLiveKey) return;
          if (!sessionLiveKey && entry.liveKey) sessionLiveKey = entry.liveKey;
        } else if (sessionId.startsWith("live:")) {
          if (entry.sessionId || entry.liveKey !== sessionLiveKey) return;
        } else if (entry.sessionId !== sessionId) {
          return;
        }
        scheduleUpdate();
      };
      liveSessionsEmitter.on("session", onSessionEvent);

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
        detailsEmitter.off("detail", onDetail);
        liveSessionsEmitter.off("session", onSessionEvent);
        if (updateTimer) clearTimeout(updateTimer);
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
