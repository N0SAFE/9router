import { NextResponse } from "next/server";
import { getApiKeys, getSettings, validateApiKey } from "@/lib/localDb";
import {
  getAgentHostState,
  listAgentEndpoints,
  listAgentSessions,
  listRemoteWorkspaces,
  prepareWorkspace,
  startAgentHost,
  stopAgentHost,
} from "@/lib/remote/agentHost";

export const dynamic = "force-dynamic";

// API-key authenticated variant of /api/remote/agent so the VS Code bridge can
// start/stop the remote agent host and list remote workspaces from the UI.

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
    const valid = await validateApiKey(key);
    if (valid) {
      return true;
    }
  } catch {
    // fall through to the key list check
  }
  try {
    const keys = await getApiKeys();
    return keys.some((entry) => entry.isActive !== false && entry.key === key);
  } catch {
    return false;
  }
}

export async function GET(request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const state = await getAgentHostState();
  const [endpoints, sessions] = await Promise.all([listAgentEndpoints(), listAgentSessions()]);
  return NextResponse.json({
    state,
    endpoints: endpoints.map((endpoint) => ({
      type: endpoint?.type || "unknown",
      protocolVersion: endpoint?.protocolVersion || null,
      pid: endpoint?.pid || null,
    })),
    sessions,
    workspaces: listRemoteWorkspaces(),
  });
}

export async function POST(request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "prepare-workspace") {
      const workspace = await prepareWorkspace({
        repo: body.repo,
        branch: body.branch,
        name: body.name,
        copyFrom: body.copyFrom,
      });
      return NextResponse.json({ workspace, workspaces: listRemoteWorkspaces() });
    }
    if (body.action !== "start") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json({ state: await startAgentHost({ name: body.name }) });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Remote agent action failed" }, { status: 400 });
  }
}

export async function DELETE(request) {
  if (!(await authorize(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ state: await stopAgentHost() });
}
