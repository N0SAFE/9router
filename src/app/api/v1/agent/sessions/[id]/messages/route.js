import { NextResponse } from "next/server";
import { authorizeApiKey, firstApiKey, resolveRouterRoot } from "@/lib/remote/apiAuth";
import { sendMessage, stopSession } from "@/lib/remote/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * POST /api/v1/agent/sessions/{id}/messages { prompt, permissionMode? }
 * Runs the harness on this machine (workspace-bound, models from 9Router) and
 * streams its events as SSE: text / thinking / tool / result / done / error.
 */
export async function POST(request, { params }) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const root = resolveRouterRoot(request);
  const apiKey = await firstApiKey();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client disconnected — the harness keeps running and the transcript
          // is persisted, so the session can be resumed later.
        }
      };
      try {
        send({ type: "start", sessionId: id });
        await sendMessage(id, prompt, {
          root,
          apiKey,
          permissionMode: body.permissionMode,
          model: typeof body.model === "string" ? body.model : undefined,
          onEvent: send,
        });
      } catch (error) {
        send({ type: "error", error: error?.message || "Agent run failed" });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      stopSession(id);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
