import { NextResponse } from "next/server";
import { authorizeApiKey } from "@/lib/remote/apiAuth";
import { forkSession } from "@/lib/remote/sessions";

export const dynamic = "force-dynamic";

/** POST /api/v1/agent/sessions/{id}/fork { title? } — branch a session. */
export async function POST(request, { params }) {
  if (!(await authorizeApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json({ session: forkSession(id, { title: body.title }) });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to fork session" }, { status: 400 });
  }
}
