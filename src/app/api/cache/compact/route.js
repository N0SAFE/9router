import { NextResponse } from "next/server";
import { compactDatabase } from "@/lib/cache/registry.js";

export const dynamic = "force-dynamic";

/** POST /api/cache/compact — VACUUM the local database and report the change. */
export async function POST() {
  try {
    const result = await compactDatabase();
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
