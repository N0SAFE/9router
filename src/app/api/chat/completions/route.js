import { handleChat } from "@/sse/handlers/chat.js";
import { getApiKeys, getSettings } from "@/lib/localDb";
import { getLastRequestDetail, getRequestDetailByClientRequestId } from "@/lib/usageDb";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const encoder = new TextEncoder();

/** Compact routing/usage summary appended to the SSE stream for the chat UI. */
function compactDetail(detail) {
  if (!detail) {
    return null;
  }
  return {
    timestamp: detail.timestamp || null,
    provider: detail.provider || null,
    model: detail.model || null,
    connectionId: detail.connectionId || null,
    status: detail.status || null,
    latency: detail.latency || null,
    tokens: detail.tokens || null,
    routing: detail.routing || null,
  };
}

/**
 * POST /api/chat/completions
 * Dashboard chat proxy: forwards the OpenAI-style body to the internal chat
 * handler with a local API key, streams the response back unchanged, and
 * appends a final `event: 9router.routing` block carrying the request's
 * combo/pool/account trace so the UI can explain what happened.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    if (!body?.model || !Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json({ error: "model and messages are required" }, { status: 400 });
    }

    const settings = await getSettings();
    let apiKey = null;
    if (settings.requireApiKey) {
      const keys = await getApiKeys();
      apiKey = keys.find((key) => key.isActive !== false)?.key || null;
      if (!apiKey) {
        return Response.json(
          { error: "No API key available — create one in Endpoint & Key." },
          { status: 400 }
        );
      }
    }

    const clientRequestId =
      typeof body.metadata?.clientRequestId === "string" ? body.metadata.clientRequestId : null;

    const internal = new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...body, stream: true }),
    });

    const startedAt = Date.now();
    const response = await handleChat(internal);
    if (!response?.body) {
      return response;
    }

    const transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      async flush(controller) {
        let detail = null;
        for (let attempt = 0; attempt < 20 && !detail; attempt += 1) {
          if (clientRequestId) {
            detail = await getRequestDetailByClientRequestId(clientRequestId).catch(() => null);
            if (detail) {
              break;
            }
          }
          const candidate = getLastRequestDetail(startedAt);
          if (candidate) {
            const candidateId = candidate?.request?.metadata?.clientRequestId;
            if (clientRequestId && candidateId && candidateId !== clientRequestId) {
              // A concurrent request finished first — keep waiting for ours.
            } else {
              detail = candidate;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        controller.enqueue(
          encoder.encode(`\nevent: 9router.routing\ndata: ${JSON.stringify(compactDetail(detail))}\n\n`)
        );
      },
    });

    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[chat] completions failed:", error);
    return Response.json({ error: error?.message || "Chat request failed" }, { status: 500 });
  }
}
