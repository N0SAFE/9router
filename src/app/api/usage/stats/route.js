import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { hasActiveFilters, parseUsageFilters } from "@/lib/usage/usageFilters.js";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const filters = parseUsageFilters(searchParams);
    const stats = await getUsageStats(period, hasActiveFilters(filters) ? filters : null);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
