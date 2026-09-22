import { NextResponse } from "next/server";
import { buildLiveRequestsPayload } from "@/lib/usage/liveRequestsView";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/live-requests
 * In-flight requests with their live routing events, plus recently persisted
 * requests (last 30 min) so the view is never empty between requests.
 */
export async function GET() {
  try {
    return NextResponse.json(await buildLiveRequestsPayload(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[API] Failed to list live requests:", error);
    return NextResponse.json({ error: "Failed to list live requests" }, { status: 500 });
  }
}
