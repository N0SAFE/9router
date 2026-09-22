import { NextResponse } from "next/server";
import { listExplicitSessions, listImplicitSessions } from "@/lib/usage/sessionPayload";
import { listSessionMonitors } from "@/lib/usage/sessionMonitors";
import { listLiveSessions } from "@/lib/usage/liveSessions";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/sessions?limit&q&live=1
 * Sessions (explicit ids + implicit groups + in-flight sessions that have no
 * detail yet), newest first, with watch-list flags attached.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limitRaw = parseInt(searchParams.get("limit"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 60;
    const liveOnly = searchParams.get("live") === "1";
    const query = (searchParams.get("q") || "").trim().toLowerCase();

    const [explicit, implicit, monitors] = await Promise.all([
      listExplicitSessions(limit),
      listImplicitSessions(limit),
      listSessionMonitors(),
    ]);
    const live = listLiveSessions();

    const byExplicitId = new Map(explicit.map((session) => [session.id, session]));
    const byLiveKey = new Map(implicit.filter((session) => session.liveKey).map((session) => [session.liveKey, session]));
    const covered = new Set();
    const merged = [];

    // 1. In-flight sessions first: they may not have a persisted detail yet.
    for (const entry of live) {
      const persisted = entry.sessionId ? byExplicitId.get(entry.sessionId) : byLiveKey.get(entry.liveKey);
      if (persisted) {
        covered.add(persisted.id);
        const persistedLast = persisted.lastAt ? new Date(persisted.lastAt).getTime() : 0;
        merged.push({
          ...persisted,
          live: true,
          generating: new Date(entry.startedAt).getTime() >= persistedLast,
          label: persisted.label || entry.label,
        });
      } else {
        merged.push({
          id: entry.id,
          kind: entry.kind,
          liveKey: entry.liveKey || null,
          label: entry.label || "running session",
          provider: entry.provider || null,
          model: entry.model || null,
          requests: entry.requests,
          failures: 0,
          tokens: 0,
          costUsd: 0,
          startedAt: entry.startedAt,
          lastAt: new Date(entry.lastEventAt).toISOString(),
          live: true,
          generating: true,
          liveOnly: true,
        });
      }
    }

    // 2. Persisted sessions not already covered by an in-flight entry.
    for (const session of [...explicit, ...implicit]) {
      if (covered.has(session.id)) continue;
      merged.push({ ...session, generating: false });
    }

    const sessions = merged
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
      .filter((session) => (liveOnly ? session.live : true))
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
        sessions,
        counts: {
          total: sessions.length,
          live: sessions.filter((session) => session.live).length,
          generating: sessions.filter((session) => session.generating).length,
          monitored: sessions.filter((session) => session.monitored).length,
          explicit: sessions.filter((session) => session.kind === "explicit").length,
          implicit: sessions.filter((session) => session.kind === "implicit").length,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to list sessions:", error);
    return NextResponse.json({ error: "Failed to list sessions" }, { status: 500 });
  }
}
