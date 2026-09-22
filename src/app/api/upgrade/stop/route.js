import { NextResponse } from "next/server";
import { stopUpgrade } from "@/lib/upgrade/agent";

export const dynamic = "force-dynamic";

// Stop a running upgrade agent (SIGTERM to the opencode process group).
export async function POST() {
  try {
    const result = stopUpgrade();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Error stopping upgrade agent:", error);
    return NextResponse.json({ error: "Failed to stop upgrade agent" }, { status: 500 });
  }
}
