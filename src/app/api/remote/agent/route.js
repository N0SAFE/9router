import { NextResponse } from "next/server";
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

function publicEndpoints(endpoints) {
  return endpoints.map((endpoint) => ({
    type: endpoint?.type || "unknown",
    protocolVersion: endpoint?.protocolVersion || null,
    pid: endpoint?.pid || null,
    connectionToken: endpoint?.connectionToken ? "set" : null,
    endpoint: endpoint?.endpoint?.type === "socket" ? { type: "socket" } : endpoint?.endpoint || null,
  }));
}

/**
 * GET /api/remote/agent
 * Remote agent host status: process state, live endpoints, active sessions and
 * prepared workspace copies.
 */
export async function GET() {
  try {
    const state = getAgentHostState();
    const [endpoints, sessions] = await Promise.all([listAgentEndpoints(), listAgentSessions()]);
    return NextResponse.json({
      state,
      endpoints: publicEndpoints(endpoints),
      sessions,
      workspaces: listRemoteWorkspaces(),
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to read agent host" }, { status: 500 });
  }
}

/**
 * POST /api/remote/agent
 * { action: "start", name? }             → start the agent host + dev tunnel
 * { action: "prepare-workspace", repo?|copyFrom?, branch?, name? }
 *                                        → clone/copy a workspace folder
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action === "prepare-workspace") {
      const result = await prepareWorkspace({
        repo: body.repo,
        branch: body.branch,
        name: body.name,
        copyFrom: body.copyFrom,
      });
      return NextResponse.json({ workspace: result, workspaces: listRemoteWorkspaces() });
    }
    if (body.action !== "start") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    const state = await startAgentHost({ name: body.name });
    return NextResponse.json({ state });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to start agent host" }, { status: 400 });
  }
}

/** DELETE /api/remote/agent — stop the managed agent host. */
export async function DELETE() {
  try {
    return NextResponse.json({ state: stopAgentHost() });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to stop agent host" }, { status: 400 });
  }
}
