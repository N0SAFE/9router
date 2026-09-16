import { NextResponse } from "next/server";
import { readServerLogs, readServerState } from "@/lib/local/processManager";

export const dynamic = "force-dynamic";

/**
 * GET /api/local/server/logs?provider=llamacpp|vllm|ollama-local&lines=120
 * Tail of the managed server's stdout/stderr log.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const provider = (searchParams.get("provider") || "").trim();
  const linesRaw = parseInt(searchParams.get("lines"), 10);
  const lines = Number.isNaN(linesRaw) ? 120 : Math.min(Math.max(linesRaw, 10), 1000);
  return NextResponse.json({
    provider,
    process: readServerState(provider),
    logs: readServerLogs(provider, lines),
  });
}

/** DELETE /api/local/server/logs?provider=… — truncate the log file. */
export async function DELETE(request) {
  const { clearServerLogs } = await import("@/lib/local/processManager");
  const { searchParams } = new URL(request.url);
  const provider = (searchParams.get("provider") || "").trim();
  clearServerLogs(provider);
  return NextResponse.json({ cleared: true });
}
