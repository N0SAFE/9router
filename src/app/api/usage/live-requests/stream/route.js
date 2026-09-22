import { buildLiveRequestsPayload } from "@/lib/usage/liveRequestsView";
import { liveRoutingEmitter } from "@/lib/usage/liveRouting";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/live-requests/stream
 * SSE: an initial `snapshot`, then an `update` on every routing event (combo,
 * model, pool, account, attempt, fallback, error, complete) — pushed straight
 * from the router, no polling.
 */
export async function GET(request) {
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
          return await buildLiveRequestsPayload();
        } catch (error) {
          return { requests: [], error: String(error?.message || error) };
        }
      };

      send("snapshot", await snapshot());

      let queued = false;
      const onRequestEvent = async () => {
        if (closed || queued) return;
        queued = true;
        // Coalesce bursts of routing events into one frame.
        setTimeout(async () => {
          queued = false;
          if (closed) return;
          send("update", await snapshot());
        }, 150);
      };
      liveRoutingEmitter.on("request", onRequestEvent);

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
        liveRoutingEmitter.off("request", onRequestEvent);
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
