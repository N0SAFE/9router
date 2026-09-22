import { detailsEmitter } from "@/lib/db/index.js";
import { buildSessionPayload } from "@/lib/usage/sessionPayload";
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

      send("snapshot", await snapshot());

      const onDetail = async (entry) => {
        if (closed) return;
        // Explicit sessions can be matched by their id; implicit groups are
        // re-derived (the new detail may extend the group).
        if (entry?.sessionId !== sessionId && !sessionId.startsWith("implicit:")) {
          return;
        }
        const payload = await snapshot();
        if (!payload?.missing) {
          send("update", payload);
        }
      };

      detailsEmitter.on("detail", onDetail);

      // A session that is still generating has no detail yet: push an update as
      // soon as its request starts so the client can attach immediately.
      const onSessionEvent = async (event) => {
        if (closed) return;
        const entry = event?.session;
        if (!entry) return;
        if (entry.sessionId && entry.sessionId !== sessionId) return;
        const payload = await snapshot();
        if (payload?.missing) return;
        if (entry.liveKey && payload.liveKey && entry.liveKey !== payload.liveKey) return;
        send("update", payload);
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
