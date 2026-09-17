import { NextResponse } from "next/server";
import { authorizeApiKey } from "@/lib/remote/apiAuth";
import { deleteSession, getSession } from "@/lib/remote/sessions";

export const dynamic = "force-dynamic";

/** GET /api/v1/agent/sessions/{id} — session transcript + status. */
export async function GET(request, { params }) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json({ session });
}

/** DELETE /api/v1/agent/sessions/{id} — stop and remove a session. */
export async function DELETE(request, { params }) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  return NextResponse.json(deleteSession(id));
}
