"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtPct = (n) => `${Math.round((n || 0) * 100)}%`;

export default function OverviewCards({ stats }) {
  const cacheHitRate = stats.totalPromptTokens > 0 ? stats.totalCachedTokens / stats.totalPromptTokens : 0;
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);

  const cards = [
    { label: "Requests", value: fmt(stats.totalRequests), tone: "text-text-main" },
    { label: "Input tokens", value: fmt(stats.totalPromptTokens), tone: "text-primary" },
    { label: "Cached", value: fmt(stats.totalCachedTokens), tone: "text-info", sub: `${fmtPct(cacheHitRate)} of input` },
    { label: "Output tokens", value: fmt(stats.totalCompletionTokens), tone: "text-success", sub: `${fmt(totalTokens)} total` },
    { label: "Est. cost", value: `~${fmtCost(stats.totalCost)}`, tone: "text-warning", sub: "estimated, not billed" },
  ];

  return (
    <div className="grid min-w-0 grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <Card key={card.label} className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
          <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-text-muted">{card.label}</span>
          <span className={`truncate font-mono text-xl font-bold tabular-nums leading-tight ${card.tone}`}>{card.value}</span>
          {card.sub && <span className="truncate text-[10px] text-text-subtle">{card.sub}</span>}
        </Card>
      ))}
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
