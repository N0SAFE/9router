import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { normalizePolicy, summarizePolicy } from "@/lib/keys/policy.js";
import { loadKeyUsage } from "@/lib/keys/policyUsage.js";
import { getKeyConcurrency } from "@/lib/keys/concurrency.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/keys/[id]/policy-usage
 * Current usage snapshot for the key's policy drawer: per-period aggregates
 * (total, per provider/model/connection), rate counters, concurrency and live
 * provider quota percentages for rules that ask for them.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const policy = normalizePolicy(key.policies);
    const concurrency = getKeyConcurrency(key.id);
    const usage = await loadKeyUsage(key.key, policy, { concurrency });

    return NextResponse.json(
      {
        keyId: key.id,
        enabled: policy.enabled,
        dryRun: policy.dryRun,
        summary: summarizePolicy(policy),
        usage,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[API] Failed to load key policy usage:", error);
    return NextResponse.json({ error: "Failed to load policy usage" }, { status: 500 });
  }
}
