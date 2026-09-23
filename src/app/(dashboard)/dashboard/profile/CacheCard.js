"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import { cn } from "@/shared/utils/cn";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "memory", label: "In-memory" },
  { value: "stored", label: "Stored" },
];

function fmtBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statsLabel(stats) {
  if (!stats) return "size not tracked";
  if (stats.error) return "unavailable";
  if (typeof stats.entries !== "number") return "size not tracked";
  return `${stats.entries.toLocaleString()} ${stats.entries === 1 ? "entry" : "entries"}`;
}

export default function CacheCard() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [report, setReport] = useState(null);
  const [compact, setCompact] = useState({ busy: false, result: null, error: "" });

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cache", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not read the cache list");
      setData(payload);
      setError("");
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const surfaces = useMemo(() => data?.surfaces || [], [data]);
  const groups = useMemo(() => data?.groups || [], [data]);
  const visible = useMemo(
    () => (filter === "all" ? surfaces : surfaces.filter((surface) => surface.group === filter)),
    [surfaces, filter]
  );

  const selectedSurfaces = useMemo(() => surfaces.filter((surface) => selected.has(surface.id)), [surfaces, selected]);
  const selectedEntries = selectedSurfaces.reduce(
    (sum, surface) => sum + (typeof surface.stats?.entries === "number" ? surface.stats.entries : 0),
    0
  );

  const toggle = (id) => {
    setReport(null);
    setConfirming(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectVisible = (on) => {
    setReport(null);
    setConfirming(false);
    setSelected((current) => {
      const next = new Set(current);
      for (const surface of visible) {
        if (on) next.add(surface.id);
        else next.delete(surface.id);
      }
      return next;
    });
  };

  const clear = async () => {
    if (selected.size === 0) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/cache/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not clear the selected caches");
      setReport(payload);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const compactDatabase = async () => {
    setCompact({ busy: true, result: null, error: "" });
    try {
      const response = await fetch("/api/cache/compact", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not compact the database");
      setCompact({ busy: false, result: payload, error: "" });
      await load();
    } catch (err) {
      setCompact({ busy: false, result: null, error: String(err?.message || err) });
    }
  };

  const storedSelected = selectedSurfaces.some((surface) => surface.group === "stored");

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-text-main">
            <span className="material-symbols-outlined text-[18px] text-text-muted">cleaning_services</span>
            Cache
          </h2>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-text-muted">
            Caches make the router fast: model lists, quota snapshots, provider session ids and the history behind the
            Usage tabs. Clearing a cache never breaks routing — memory caches refill on the next request, stored history
            does not come back.
          </p>
        </div>
        <span className="font-mono text-[10px] tabular-nums text-text-subtle">
          database {fmtBytes(data?.databaseBytes)}
        </span>
      </div>

      {error ? (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn(
              "rounded-lg px-2 py-1 font-mono text-[10.5px] transition-colors",
              filter === option.value
                ? "bg-brand-500/12 text-brand-600 dark:text-brand-400"
                : "text-text-subtle hover:bg-surface-2 hover:text-text-muted"
            )}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => selectVisible(true)} className="font-mono text-[10px] text-text-subtle hover:text-text-main">
            select all
          </button>
          <button type="button" onClick={() => selectVisible(false)} className="font-mono text-[10px] text-text-subtle hover:text-text-main">
            none
          </button>
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-4">
        {loading && surfaces.length === 0 ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((row) => (
              <div key={row} className="skeleton-row flex flex-col gap-2 rounded-xl border border-border-subtle px-3 py-3">
                <span className="h-2.5 w-1/3 rounded-full bg-surface-2" />
                <span className="h-2 w-2/3 rounded-full bg-surface-2" />
              </div>
            ))}
          </div>
        ) : (
          groups
            .filter((group) => filter === "all" || group.id === filter)
            .map((group) => {
              const groupSurfaces = visible.filter((surface) => surface.group === group.id);
              if (groupSurfaces.length === 0) return null;
              return (
                <section key={group.id} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle">{group.label}</span>
                    <span className="text-[11px] text-text-muted">{group.description}</span>
                  </div>
                  <div className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle">
                    {groupSurfaces.map((surface) => {
                      const isSelected = selected.has(surface.id);
                      return (
                        <label
                          key={surface.id}
                          className={cn(
                            "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors",
                            isSelected ? "bg-brand-500/5" : "hover:bg-surface-2/40"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggle(surface.id)}
                            className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-brand-500)]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-[12.5px] font-medium text-text-main">{surface.label}</span>
                              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums text-text-muted">
                                {statsLabel(surface.stats)}
                              </span>
                              {surface.group === "stored" ? (
                                <span className="rounded-md bg-warning/10 px-1.5 py-0.5 font-mono text-[9.5px] text-warning">
                                  permanent
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 block text-[11.5px] leading-relaxed text-text-muted">{surface.description}</span>
                            {surface.warning ? (
                              <span className="mt-1 block text-[11px] leading-relaxed text-warning">{surface.warning}</span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border-subtle bg-bg px-3 py-2.5">
        <span className="font-mono text-[11px] tabular-nums text-text-muted">
          {selectedSurfaces.length} selected
          {selectedEntries > 0 ? ` · ${selectedEntries.toLocaleString()} entries` : ""}
        </span>
        {storedSelected ? (
          <span className="text-[11px] text-warning">stored history cannot be restored</span>
        ) : selectedSurfaces.length > 0 ? (
          <span className="text-[11px] text-text-subtle">safe — memory caches refill automatically</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {confirming ? (
            <button type="button" onClick={() => setConfirming(false)} className="font-mono text-[10.5px] text-text-subtle hover:text-text-main">
              cancel
            </button>
          ) : null}
          <Button
            size="sm"
            variant={confirming ? "primary" : "outline"}
            loading={busy}
            disabled={selected.size === 0}
            onClick={clear}
            icon={confirming ? "warning" : "delete_sweep"}
          >
            {confirming ? `Confirm — clear ${selectedSurfaces.length}` : "Clear selected"}
          </Button>
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-border-subtle bg-surface-2/30 px-3 py-2.5">
        <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-text-muted">
          <span className="font-medium text-text-main">Compact database</span> — SQLite keeps the pages of deleted rows.
          Vacuuming rewrites the file and returns that space to the disk. Routing is paused for the moment it takes.
        </span>
        <span className="font-mono text-[10.5px] tabular-nums text-text-subtle">{fmtBytes(data?.databaseBytes)}</span>
        <Button size="sm" variant="outline" icon="compress" loading={compact.busy} onClick={compactDatabase}>
          Compact
        </Button>
      </div>

      {compact.error ? <p className="mt-2 text-[11.5px] text-danger">{compact.error}</p> : null}
      {compact.result ? (
        <p className="mt-2 font-mono text-[10.5px] tabular-nums text-emerald-600 dark:text-emerald-400">
          {fmtBytes(compact.result.before)} → {fmtBytes(compact.result.after)}
          {compact.result.savedBytes ? ` · ${fmtBytes(compact.result.savedBytes)} reclaimed` : ""}
        </p>
      ) : null}

      {report ? (
        <div className="mt-3 flex flex-col gap-1.5 rounded-xl border border-border-subtle bg-surface-2/40 px-3 py-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-subtle">last clean</span>
          {report.cleared.map((entry) => (
            <span key={entry.id} className="flex flex-wrap items-baseline gap-2 text-[11.5px] text-text-muted">
              <span className="material-symbols-outlined text-[13px] text-emerald-500">check_circle</span>
              <span className="text-text-main">{entry.label}</span>
              <span className="font-mono text-[10.5px] tabular-nums">
                {entry.removed !== null && entry.removed !== undefined ? `${entry.removed.toLocaleString()} removed` : entry.detail || "cleared"}
              </span>
            </span>
          ))}
          {report.errors.map((entry) => (
            <span key={entry.id} className="flex flex-wrap items-baseline gap-2 text-[11.5px] text-danger">
              <span className="material-symbols-outlined text-[13px]">error</span>
              <span>{entry.label}</span>
              <span className="font-mono text-[10.5px]">{entry.error}</span>
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
