import { NextResponse } from "next/server";
import { buildSessionPayload } from "@/lib/usage/sessionPayload";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/sessions/[id]
 * Full session payload: turns (tokens/cost/latency/speeds/tools/routing),
 * chat deltas, spikes, budget progress. Works for explicit ids and for
 * implicit ids (URL-encoded, e.g. implicit%3A...).
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const sessionId = decodeURIComponent(id || "");
    if (!sessionId) {
      return NextResponse.json({ error: "A session id is required" }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const absoluteCostUsd = Number(searchParams.get("spikeCost"));
    const absoluteTokens = Number(searchParams.get("spikeTokens"));
    const payload = await buildSessionPayload(sessionId, {
      spikeOptions: {
        ...(Number.isFinite(absoluteCostUsd) && absoluteCostUsd > 0 ? { absoluteCostUsd } : {}),
        ...(Number.isFinite(absoluteTokens) && absoluteTokens > 0 ? { absoluteTokens } : {}),
      },
    });

    if (payload.missing) {
      return NextResponse.json({ error: "Session not found", id: sessionId }, { status: 404 });
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to load session:", error);
    return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
  }
}
