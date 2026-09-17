import { NextResponse } from "next/server";
import { authorizeApiKey } from "@/lib/remote/apiAuth";
import { readTunnelState, startWorkspaceTunnel, stopWorkspaceTunnel } from "@/lib/remote/tunnel";

export const dynamic = "force-dynamic";

/** GET /api/v1/remote/tunnel — API-key variant of the workspace tunnel status. */
export async function GET(request) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ tunnel: readTunnelState() });
}

/** POST /api/v1/remote/tunnel { name?, service? } */
export async function POST(request) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({
      tunnel: await startWorkspaceTunnel({ name: body.name, service: body.service === true }),
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to start the tunnel" }, { status: 400 });
  }
}

/** DELETE /api/v1/remote/tunnel */
export async function DELETE(request) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ tunnel: stopWorkspaceTunnel() });
}
