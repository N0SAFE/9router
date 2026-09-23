import { NextResponse } from "next/server";
import { clearCacheSurfaces } from "@/lib/cache/registry.js";

export const dynamic = "force-dynamic";

/** POST /api/cache/clear — body: { ids: string[] } */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "Select at least one cache to clear" }, { status: 400 });
    }
    const result = await clearCacheSurfaces(ids);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
