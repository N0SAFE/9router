import { NextResponse } from "next/server";
import { readTunnelLogs, readTunnelState, startWorkspaceTunnel, stopWorkspaceTunnel } from "@/lib/remote/tunnel";

export const dynamic = "force-dynamic";

/** GET /api/remote/tunnel — workspace tunnel status + connect URL. */
export async function GET() {
  return NextResponse.json({ tunnel: readTunnelState(), logs: readTunnelLogs(80) });
}

/**
 * POST /api/remote/tunnel { name?, service? }
 * Starts `code tunnel` (VS Code Server + tunnel) on this machine.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const tunnel = await startWorkspaceTunnel({ name: body.name, service: body.service === true });
    return NextResponse.json({ tunnel, logs: readTunnelLogs(40) });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to start the tunnel" }, { status: 400 });
  }
}

/** DELETE /api/remote/tunnel — stop the managed tunnel. */
export async function DELETE() {
  return NextResponse.json({ tunnel: stopWorkspaceTunnel() });
}
