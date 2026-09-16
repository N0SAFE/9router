import { NextResponse } from "next/server";
import { readAgentHostLogs } from "@/lib/remote/agentHost";

export const dynamic = "force-dynamic";

/** GET /api/remote/agent/logs?lines=200 — agent host CLI output tail. */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const linesRaw = parseInt(searchParams.get("lines"), 10);
  const lines = Number.isNaN(linesRaw) ? 200 : Math.min(Math.max(linesRaw, 10), 1000);
  return NextResponse.json({ logs: readAgentHostLogs(lines) });
}
