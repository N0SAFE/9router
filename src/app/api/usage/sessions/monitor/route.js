import { NextResponse } from "next/server";
import {
  deleteSessionMonitor,
  listSessionMonitors,
  upsertSessionMonitor,
} from "@/lib/usage/sessionMonitors";

export const dynamic = "force-dynamic";

/** GET /api/usage/sessions/monitor — the watch list. */
export async function GET() {
  try {
    return NextResponse.json({ monitors: await listSessionMonitors() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to list session monitors:", error);
    return NextResponse.json({ error: "Failed to list monitors" }, { status: 500 });
  }
}

/**
 * POST /api/usage/sessions/monitor { sessionId, label?, pinned?, budgetUsd?, budgetTokens? }
 * Adds/updates a session in the watch list (this is what the chat panel's
 * "Monitor" toggle and the Sessions tab's budget editor call).
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }
    const monitor = await upsertSessionMonitor(sessionId, {
      label: body.label,
      pinned: body.pinned,
      budgetUsd: body.budgetUsd,
      budgetTokens: body.budgetTokens,
    });
    return NextResponse.json({ monitor });
  } catch (error) {
    console.error("[API] Failed to update session monitor:", error);
    return NextResponse.json({ error: "Failed to update monitor" }, { status: 500 });
  }
}

/** DELETE /api/usage/sessions/monitor?sessionId=… — stop watching a session. */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = decodeURIComponent(searchParams.get("sessionId") || "");
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }
    const removed = await deleteSessionMonitor(sessionId);
    return NextResponse.json({ removed });
  } catch (error) {
    console.error("[API] Failed to delete session monitor:", error);
    return NextResponse.json({ error: "Failed to delete monitor" }, { status: 500 });
  }
}
