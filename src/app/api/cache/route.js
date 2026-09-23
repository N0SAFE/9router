import { NextResponse } from "next/server";
import { listCacheSurfaces } from "@/lib/cache/registry.js";

export const dynamic = "force-dynamic";

/** GET /api/cache — every clearable surface with its current size. */
export async function GET() {
  try {
    const payload = await listCacheSurfaces();
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
