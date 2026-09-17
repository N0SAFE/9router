import { NextResponse } from "next/server";
import { authorizeApiKey } from "@/lib/remote/apiAuth";
import { createSession, listSessions } from "@/lib/remote/sessions";

export const dynamic = "force-dynamic";

/** GET /api/v1/agent/sessions — list cloud agent sessions. */
export async function GET(request) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ sessions: listSessions() });
}

/**
 * POST /api/v1/agent/sessions { workspace?, model?, title? }
 * Create a session bound to a workspace copy on this machine.
 */
export async function POST(request) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({
      session: createSession({ workspace: body.workspace, model: body.model, title: body.title }),
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to create session" }, { status: 400 });
  }
}
