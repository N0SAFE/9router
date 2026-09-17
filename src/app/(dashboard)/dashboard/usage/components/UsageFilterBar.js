"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";

// Dense global filter bar for the Usage page. Options are derived from the
// unfiltered stats of the current period so they never disappear while a
// filter is active.

const SELECT_CLASS =
  "h-8 min-w-0 max-w-[190px] cursor-pointer rounded-lg border border-border bg-surface px-2 text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20";

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
];

function uniq(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (!entry || !entry.value || seen.has(entry.value)) continue;
    seen.add(entry.value);
    out.push(entry);
  }
  return out;
}

function buildOptions(stats) {
  const providers = Object.keys(stats?.byProvider || {}).sort();
  const models = uniq(
    Object.values(stats?.byModel || {}).map((entry) => ({
      value: entry.rawModel,
      label: entry.provider ? `${entry.rawModel} · ${entry.provider}` : entry.rawModel,
    }))
  ).sort((a, b) => a.value.localeCompare(b.value));
  const connections = uniq(
    Object.values(stats?.byAccount || {})
      .filter((entry) => entry.connectionId)
      .map((entry) => ({
        value: entry.connectionId,
        label: `${entry.accountName} · ${entry.provider}`,
      }))
  ).sort((a, b) => a.label.localeCompare(b.label));
  const apiKeys = uniq(
    Object.values(stats?.byApiKey || {}).map((entry) => ({
      value: entry.keyName === "Local (No API Key)" ? "local-no-key" : entry.keyName,
      label: entry.keyName,
    }))
  ).sort((a, b) => a.label.localeCompare(b.label));
  const endpoints = uniq(
    Object.values(stats?.byEndpoint || {}).map((entry) => ({
      value: entry.endpoint,
      label: entry.endpoint,
    }))
  ).sort((a, b) => a.value.localeCompare(b.value));
  return { providers, models, connections, apiKeys, endpoints };
}

export default function UsageFilterBar({ period = "7d", filters = {}, onPatch, onClear }) {
  const [options, setOptions] = useState(null);
  const [search, setSearch] = useState(filters.q || "");
  const debounceRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/usage/stats?period=${encodeURIComponent(period)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setOptions(buildOptions(data));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [period]);

  useEffect(() => {
    // Keep the input in sync when filters are cleared/changed elsewhere.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearch(filters.q || "");
  }, [filters.q]);

  const activeCount = useMemo(() => Object.keys(filters).length, [filters]);

  const handleSearch = (value) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onPatch?.({ q: value.trim() }), 350);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        aria-label="Provider filter"
        className={SELECT_CLASS}
        value={filters.provider || ""}
        onChange={(event) => onPatch?.({ provider: event.target.value, model: "", connectionId: "" })}
      >
        <option value="">All providers</option>
        {(options?.providers || []).map((provider) => (
          <option key={provider} value={provider}>{provider}</option>
        ))}
      </select>

      <select
        aria-label="Model filter"
        className={SELECT_CLASS}
        value={filters.model || ""}
        onChange={(event) => onPatch?.({ model: event.target.value })}
      >
        <option value="">All models</option>
        {(options?.models || []).map((model) => (
          <option key={model.value} value={model.value}>{model.label}</option>
        ))}
      </select>

      <select
        aria-label="Connection filter"
        className={SELECT_CLASS}
        value={filters.connectionId || ""}
        onChange={(event) => onPatch?.({ connectionId: event.target.value })}
      >
        <option value="">All connections</option>
        {(options?.connections || []).map((connection) => (
          <option key={connection.value} value={connection.value}>{connection.label}</option>
        ))}
      </select>

      <select
        aria-label="Status filter"
        className={SELECT_CLASS}
        value={filters.status || ""}
        onChange={(event) => onPatch?.({ status: event.target.value })}
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>

      <select
        aria-label="API key filter"
        className={SELECT_CLASS}
        value={filters.apiKeyId || ""}
        onChange={(event) => onPatch?.({ apiKeyId: event.target.value })}
      >
        <option value="">All API keys</option>
        {(options?.apiKeys || []).map((key) => (
          <option key={key.value} value={key.value}>{key.label}</option>
        ))}
      </select>

      <select
        aria-label="Endpoint filter"
        className={SELECT_CLASS}
        value={filters.endpoint || ""}
        onChange={(event) => onPatch?.({ endpoint: event.target.value })}
      >
        <option value="">All endpoints</option>
        {(options?.endpoints || []).map((endpoint) => (
          <option key={endpoint.value} value={endpoint.value}>{endpoint.label}</option>
        ))}
      </select>

      <input
        aria-label="Search requests"
        placeholder="Search model, provider…"
        value={search}
        onChange={(event) => handleSearch(event.target.value)}
        className="h-8 w-44 rounded-lg border border-border bg-surface px-2 text-xs text-text-main placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-primary/20"
      />

      {activeCount > 0 && (
        <button
          type="button"
          onClick={() => onClear?.()}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs font-medium text-text-muted",
            "transition-colors hover:bg-surface-2 hover:text-text-main"
          )}
        >
          <span className="material-symbols-outlined text-[14px]">filter_alt_off</span>
          Clear {activeCount}
        </button>
      )}
    </div>
  );
}
