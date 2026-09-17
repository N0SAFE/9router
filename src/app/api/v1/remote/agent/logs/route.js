import { NextResponse } from "next/server";
import { getApiKeys, getSettings } from "@/lib/localDb";
import { readAgentHostLogs } from "@/lib/remote/agentHost";

export const dynamic = "force-dynamic";

async function authorize(request) {
  let settings = {};
  try {
    settings = await getSettings();
  } catch {
    settings = {};
  }
  if (settings.requireApiKey === false) {
    return true;
  }
  const header = request.headers.get("Authorization") || "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) {
    return false;
  }
  try {
    const keys = await getApiKeys();
    return keys.some((entry) => entry.isActive !== false && entry.key === key);
  } catch {
    return false;
  }
}

/** GET /api/v1/remote/agent/logs?lines=200 — API-key authenticated log tail. */
export async function GET(request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const linesRaw = parseInt(searchParams.get("lines"), 10);
  const lines = Number.isNaN(linesRaw) ? 200 : Math.min(Math.max(linesRaw, 10), 2000);
  return NextResponse.json({ logs: readAgentHostLogs(lines) });
}
