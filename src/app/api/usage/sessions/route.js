import { NextResponse } from "next/server";
import { listExplicitSessions, listImplicitSessions } from "@/lib/usage/sessionPayload";
import { listSessionMonitors } from "@/lib/usage/sessionMonitors";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/sessions?limit&q
 * Sessions (explicit session ids + implicit groups from the recent details
 * ring), newest first, with the watch-list flags attached.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limitRaw = parseInt(searchParams.get("limit"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 60;
    const query = (searchParams.get("q") || "").trim().toLowerCase();

    const [explicit, implicit, monitors] = await Promise.all([
      listExplicitSessions(limit),
      listImplicitSessions(limit),
      listSessionMonitors(),
    ]);

    const merged = [...explicit, ...implicit]
      .map((session) => {
        const monitor = monitors[session.id] || null;
        return {
          ...session,
          monitored: Boolean(monitor),
          pinned: monitor?.pinned === true,
          budgetUsd: monitor?.budgetUsd ?? null,
          budgetTokens: monitor?.budgetTokens ?? null,
          budgetExceeded: Boolean(
            monitor && (
              (monitor.budgetUsd != null && session.costUsd >= monitor.budgetUsd) ||
              (monitor.budgetTokens != null && session.tokens >= monitor.budgetTokens)
            )
          ),
        };
      })
      .filter((session) => {
        if (!query) return true;
        return [session.label, session.model, session.provider, session.id]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0))
      .slice(0, limit);

    return NextResponse.json(
      {
        sessions: merged,
        counts: {
          total: merged.length,
          live: merged.filter((session) => session.live).length,
          monitored: merged.filter((session) => session.monitored).length,
          explicit: merged.filter((session) => session.kind === "explicit").length,
          implicit: merged.filter((session) => session.kind === "implicit").length,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to list sessions:", error);
    return NextResponse.json({ error: "Failed to list sessions" }, { status: 500 });
  }
}
