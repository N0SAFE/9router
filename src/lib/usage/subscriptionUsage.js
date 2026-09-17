/**
 * Subscription utilization analysis.
 *
 * For plan-based provider connections, look at the last N calendar months of
 * gateway traffic and flag connections that are not pulling their weight:
 * idle months, low share of the provider's traffic, or long idle stretches —
 * while sibling connections carry the load. The output is human-readable so it
 * can be shown as messages or handed to an LLM as an optimization report.
 *
 * History cannot know a plan's exact quota, so "not used to its maximum" is
 * defined relative to the connection's siblings and its own activity, and the
 * wording says so explicitly.
 */

export const VERDICTS = ["healthy", "underused", "idle", "unused", "inactive"];

const VERDICT_META = {
  healthy: { label: "pulling weight", tone: "success" },
  underused: { label: "underused", tone: "warning" },
  idle: { label: "never used", tone: "error" },
  unused: { label: "no traffic", tone: "neutral" },
  inactive: { label: "turned off", tone: "neutral" },
};

export function verdictMeta(verdict) {
  return VERDICT_META[verdict] || VERDICT_META.healthy;
}

/** Last N calendar month descriptors, oldest first. Local time like the rest of the app. */
export function buildMonths(count = 3, now = new Date()) {
  const months = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
    const isCurrent = i === 0;
    const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    months.push({
      key,
      label: start.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
      shortLabel: start.toLocaleDateString("en-US", { month: "short" }),
      days,
      elapsedDays: isCurrent ? now.getDate() : days,
      current: isCurrent,
    });
  }
  return months;
}

function fmt(n) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
}

/**
 * @param {object} options
 * @param {Array} options.connections     - [{ id, provider, name, isActive }]
 * @param {Array} options.usageRows       - [{ connectionId, month, requests, tokens, activeDays }]
 * @param {Array} options.providerRows    - [{ provider, month, requests }]
 * @param {Array} options.months          - from buildMonths()
 * @param {object} [options.providerLabels]- provider id → display name
 * @param {number} [options.minProviderTraffic] - below this, no verdicts are drawn
 */
export function analyzeSubscriptionUsage({
  connections = [],
  usageRows = [],
  providerRows = [],
  months = buildMonths(3),
  providerLabels = {},
  minProviderTraffic = 20,
} = {}) {
  const monthKeys = months.map((month) => month.key);
  const usageByConnection = new Map();
  for (const row of usageRows) {
    if (!row?.connectionId || !monthKeys.includes(row.month)) continue;
    if (!usageByConnection.has(row.connectionId)) usageByConnection.set(row.connectionId, new Map());
    usageByConnection.get(row.connectionId).set(row.month, row);
  }

  const providerTraffic = new Map();
  for (const row of providerRows) {
    if (!row?.provider || !monthKeys.includes(row.month)) continue;
    providerTraffic.set(row.provider, (providerTraffic.get(row.provider) || 0) + (row.requests || 0));
  }

  const byProvider = new Map();
  for (const connection of connections) {
    if (!connection?.provider) continue;
    if (!byProvider.has(connection.provider)) byProvider.set(connection.provider, []);
    byProvider.get(connection.provider).push(connection);
  }

  const providers = [];
  const recommendations = [];

  for (const [provider, providerConnections] of byProvider) {
    const totalRequests = providerTraffic.get(provider) || 0;
    const totalTokens = [...usageByConnection.values()]
      .flatMap((monthMap) => [...monthMap.values()])
      .filter((row) => providerConnections.some((connection) => connection.id === row.connectionId))
      .reduce((sum, row) => sum + (row.tokens || 0), 0);

    // Months before the provider had any traffic are not evidence of underuse:
    // only months with provider activity (plus the current one) count.
    const activeMonths = months.filter(
      (month) =>
        month.current ||
        providerRows.some((row) => row.provider === provider && row.month === month.key && (row.requests || 0) > 0)
    );
    const idleEligibleMonths = activeMonths.filter((month) => !month.current || activeMonths.length === 1);
    const providerHasTraffic = totalRequests > 0;

    const enriched = providerConnections.map((connection) => {
      const monthMap = usageByConnection.get(connection.id) || new Map();
      const monthRows = months.map((month) => {
        const row = monthMap.get(month.key);
        const requests = row?.requests || 0;
        const activeDays = row?.activeDays || 0;
        return {
          month: month.key,
          label: month.shortLabel,
          requests,
          tokens: row?.tokens || 0,
          activeDays,
          idleDays: Math.max(0, month.elapsedDays - activeDays),
          current: month.current,
          eligible: activeMonths.some((active) => active.key === month.key),
        };
      });

      const requests = monthRows.reduce((sum, row) => sum + row.requests, 0);
      const tokens = monthRows.reduce((sum, row) => sum + row.tokens, 0);
      const activeDays = monthRows.reduce((sum, row) => sum + row.activeDays, 0);
      const idleDays = monthRows.reduce((sum, row) => sum + row.idleDays, 0);
      const idleMonths = idleEligibleMonths.filter((month) => (monthMap.get(month.key)?.requests || 0) === 0).length;
      const share = totalRequests > 0 ? requests / totalRequests : 0;

      let verdict = "healthy";
      if (connection.isActive === false) verdict = "inactive";
      else if (!providerHasTraffic) verdict = "unused";
      else if (requests === 0) verdict = "idle";
      else if (
        idleMonths >= Math.ceil(idleEligibleMonths.length / 2) ||
        (totalRequests >= minProviderTraffic && share < 0.1)
      ) {
        verdict = "underused";
      }

      return {
        id: connection.id,
        name: connection.name || connection.id?.slice(0, 8) || "connection",
        isActive: connection.isActive !== false,
        requests,
        tokens,
        activeDays,
        idleDays,
        idleMonths,
        eligibleMonths: idleEligibleMonths.length,
        share,
        monthRows,
        verdict,
        label: verdictMeta(verdict).label,
      };
    });

    enriched.sort((a, b) => b.requests - a.requests);

    const flagged = enriched.filter((entry) => entry.verdict === "idle" || entry.verdict === "underused");
    const siblingTraffic = totalRequests;
    const messages = [];

    if (!providerHasTraffic) {
      messages.push(
        `No traffic recorded for ${providerLabels[provider] || provider} in the selected months — nothing to optimize from history alone.`
      );
    } else if (flagged.length > 0) {
      const parts = [];
      for (const entry of flagged) {
        const pct = Math.round(entry.share * 100);
        const trafficWord = entry.requests === 0 ? "0 requests" : `${fmt(entry.requests)} requests (${pct}% of provider traffic)`;
        const windowWord =
          entry.eligibleMonths > 1
            ? `in ${entry.idleMonths} of the last ${entry.eligibleMonths} active months`
            : "since traffic started";
        parts.push(
          `**${entry.name}** was not used to its maximum ${windowWord} — ${trafficWord}, ${entry.idleDays} idle day${entry.idleDays === 1 ? "" : "s"}.`
        );
      }
      messages.push(parts.join(" "));

      const carried = enriched.filter((entry) => entry.requests > 0);
      const carriedShare = carried.reduce((sum, entry) => sum + entry.share, 0);
      if (providerConnections.length > 1) {
        messages.push(
          `${carried.length} of ${providerConnections.length} connection(s) carried ${Math.round(carriedShare * 100)}% of ${fmt(siblingTraffic)} requests. Optimize: consolidate onto the used connection(s) and cancel or pause the idle one(s), or rebalance routing weights so every paid seat is consumed.`
        );
      } else {
        messages.push("Optimize: pause or cancel this subscription, or route more work to it before the next billing cycle.");
      }

      recommendations.push({
        provider,
        providerLabel: providerLabels[provider] || provider,
        severity: flagged.some((entry) => entry.verdict === "idle") ? "high" : "medium",
        title: `${flagged.length} underused connection${flagged.length > 1 ? "s" : ""} · ${providerLabels[provider] || provider}`,
        message: messages.join(" "),
        connections: flagged.map((entry) => ({ id: entry.id, name: entry.name, verdict: entry.verdict, requests: entry.requests, share: entry.share })),
      });
    } else {
      messages.push(
        `All ${providerConnections.length} connection(s) carried traffic (${fmt(siblingTraffic)} requests total). No consolidation opportunity detected.`
      );
    }

    providers.push({
      provider,
      providerLabel: providerLabels[provider] || provider,
      connections: enriched,
      totalRequests,
      totalTokens,
      flagged: flagged.length,
      idleConnections: enriched.filter((entry) => entry.verdict === "idle").length,
      hasTraffic: providerHasTraffic,
      messages,
    });
  }

  providers.sort((a, b) => b.flagged - a.flagged || b.totalRequests - a.totalRequests);

  return {
    months: months.map((month) => ({ key: month.key, label: month.label, shortLabel: month.shortLabel, current: month.current })),
    providers,
    recommendations,
    summary: {
      providers: providers.length,
      connections: providers.reduce((sum, entry) => sum + entry.connections.length, 0),
      flaggedConnections: providers.reduce((sum, entry) => sum + (entry.hasTraffic ? entry.flagged : 0), 0),
      idleConnections: providers.reduce((sum, entry) => sum + (entry.hasTraffic ? entry.idleConnections : 0), 0),
      unusedConnections: providers.reduce((sum, entry) => sum + (entry.hasTraffic ? 0 : entry.connections.length), 0),
      requests: providers.reduce((sum, entry) => sum + entry.totalRequests, 0),
    },
  };
}

/** Markdown report of the analysis, ready to copy or hand to an LLM. */
export function buildSubscriptionReport(analysis, { generatedAt = new Date() } = {}) {
  const lines = [];
  lines.push("# 9Router subscription utilization report");
  lines.push("");
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push(
    `Window: last ${analysis.months.length} month(s) (${analysis.months[0]?.label} → ${analysis.months[analysis.months.length - 1]?.label})`
  );
  lines.push("");
  lines.push(
    `Summary: ${analysis.summary.connections} connection(s) across ${analysis.summary.providers} provider(s); ` +
      `${analysis.summary.flaggedConnections} underused or idle (${analysis.summary.idleConnections} with zero traffic), ` +
      `${analysis.summary.unusedConnections} in providers without any traffic.`
  );
  lines.push("");

  if (analysis.recommendations.length === 0) {
    lines.push("No consolidation opportunities detected: every connection carried traffic in the window.");
  } else {
    lines.push("## Optimization opportunities");
    lines.push("");
    for (const recommendation of analysis.recommendations) {
      lines.push(`### ${recommendation.title} (${recommendation.severity})`);
      lines.push("");
      lines.push(recommendation.message);
      lines.push("");
      const connection = recommendation.connections[0];
      if (connection) {
        lines.push(
          `Affected: ${recommendation.connections.map((entry) => `${entry.name} [${entry.verdict}, ${entry.requests} req]`).join(", ")}`
        );
        lines.push("");
      }
    }
  }

  lines.push("## Per-provider detail");
  lines.push("");
  for (const provider of analysis.providers) {
    lines.push(`### ${provider.providerLabel}`);
    lines.push("");
    lines.push(`- total: ${provider.totalRequests} requests`);
    for (const connection of provider.connections) {
      const months = connection.monthRows
        .map((row) => `${row.label} ${row.requests} req/${row.idleDays}d idle`)
        .join(" · ");
      lines.push(`- **${connection.name}** [${connection.label}] share ${Math.round(connection.share * 100)}% — ${months}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
