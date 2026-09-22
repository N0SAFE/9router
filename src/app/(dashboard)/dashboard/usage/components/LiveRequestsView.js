"use client";

import { useEffect, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import { cn } from "@/shared/utils/cn";
import { fmtCompact, fmtCost } from "./format";

const EVENT_ICON = {
  combo: "account_tree",
  "combo-model": "model_training",
  model: "model_training",
  pool: "hub",
  account: "account_circle",
  attempt: "warning",
  fallback: "restart_alt",
  error: "error",
  streaming: "play_circle",
  complete: "check_circle",
  note: "info",
};

const EVENT_TONE = {
  combo: "text-brand-500",
  "combo-model": "text-text-muted",
  model: "text-text-main",
  pool: "text-text-muted",
  account: "text-emerald-500",
  attempt: "text-warning",
  fallback: "text-warning",
  error: "text-danger",
  streaming: "text-sky-500",
  complete: "text-emerald-500",
  note: "text-text-muted",
};

const STATUS_VARIANT = {
  routing: "info",
  fallback: "warning",
  streaming: "primary",
  completed: "success",
  error: "error",
};

const STATUS_LABEL = {
  routing: "routing",
  fallback: "fallback",
  streaming: "streaming",
  completed: "completed",
  error: "failed",
};

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

function clockOf(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function LiveRequestsView({ initialRequestId = null, onOpenSession }) {
  const [requests, setRequests] = useState([]);
  const [counts, setCounts] = useState(null);
  const [selectedId, setSelectedId] = useState(initialRequestId);
  const [live, setLive] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const apply = (payload) => {
      if (!payload || payload.error) {
        setError(payload?.error || "Failed to load live requests");
        return;
      }
      setError("");
      setRequests(payload.requests || []);
      setCounts(payload.counts || null);
      setSelectedId((current) => current || payload.requests?.[0]?.id || null);
    };

    if (!live) {
      let cancelled = false;
      fetch("/api/usage/live-requests", { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => {
          if (!cancelled) apply(payload);
        })
        .catch((err) => !cancelled && setError(String(err?.message || err)));
      return () => {
        cancelled = true;
      };
    }

    const source = new EventSource("/api/usage/live-requests/stream");
    const onFrame = (event) => {
      try {
        apply(JSON.parse(event.data));
      } catch {
        // ignore malformed frame
      }
    };
    source.addEventListener("snapshot", onFrame);
    source.addEventListener("update", onFrame);
    return () => source.close();
  }, [live]);

  const selected = useMemo(
    () => requests.find((entry) => entry.id === selectedId) || requests[0] || null,
    [requests, selectedId]
  );

  const elapsedMs = selected
    ? (selected.persisted ? selected.durationMs : selected.finishedAtMs
        ? selected.durationMs
        : now - (selected.startedAtMs || now))
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        {/* Request list */}
        <Card padding="sm" className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-text-muted">route</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Live requests</span>
            </div>
            <Button size="sm" variant="ghost" icon={live ? "pause" : "play_arrow"} onClick={() => setLive((value) => !value)}>
              {live ? "Pause" : "Resume"}
            </Button>
          </div>
          {counts ? (
            <p className="text-[10px] text-text-subtle">
              {counts.routing} routing · {counts.streaming} streaming · {counts.errors} failed
              {counts.contextProblems > 0 ? ` · ${counts.contextProblems} context/limit` : ""}
            </p>
          ) : null}

          <div className="flex max-h-[560px] flex-col divide-y divide-border-subtle overflow-y-auto">
            {requests.length === 0 ? (
              <p className="p-4 text-xs text-text-muted">
                No requests yet. Send a chat through 9Router and it appears here the moment it enters routing.
              </p>
            ) : (
              requests.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  className={cn(
                    "flex flex-col gap-0.5 px-2 py-2 text-left transition-colors hover:bg-surface-2/60",
                    selected?.id === entry.id && "bg-primary/5"
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Badge variant={STATUS_VARIANT[entry.status] || "neutral"} size="sm">
                      {STATUS_LABEL[entry.status] || entry.status}
                    </Badge>
                    {entry.contextProblem ? (
                      <span className="material-symbols-outlined text-[13px] text-danger" title="context/limit problem">report</span>
                    ) : null}
                    <span className="truncate text-xs font-medium text-text-main">
                      {entry.label || entry.requestedModel || entry.id}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-[10px] text-text-muted">
                    <span className="truncate font-mono">{entry.requestedModel || "—"}</span>
                    {entry.combo ? <span className="text-brand-500">combo {entry.combo}</span> : null}
                    <span className="ml-auto">
                      {entry.persisted
                        ? fmtElapsed(entry.durationMs)
                        : entry.finishedAtMs
                          ? fmtElapsed(entry.durationMs)
                          : fmtElapsed(now - (entry.startedAtMs || now))}
                    </span>
                  </span>
                  {entry.attempts?.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-1 text-[10px] text-text-subtle">
                      {entry.attempts.slice(-4).map((attempt, index) => (
                        <span key={index} className="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono">
                          {attempt.name || attempt.connectionId?.slice(0, 6) || "account"} · {attempt.status ?? "?"}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </Card>

        {/* Routing trace */}
        <Card padding="sm" className="flex min-w-0 flex-col gap-3">
          {!selected ? (
            <div className="flex h-[320px] items-center justify-center text-sm text-text-muted">
              Select a request to see how it was routed.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-text-main">
                      {selected.requestedModel || selected.id}
                    </h3>
                    <Badge variant={STATUS_VARIANT[selected.status] || "neutral"} size="sm">
                      {STATUS_LABEL[selected.status] || selected.status}
                    </Badge>
                    {selected.combo ? <Badge variant="primary" size="sm">combo {selected.combo}</Badge> : null}
                    {selected.contextProblem ? <Badge variant="error" size="sm">context/limit</Badge> : null}
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                    <span>{selected.provider || "?"}/{selected.model || "?"}</span>
                    <span>{fmtElapsed(elapsedMs)}</span>
                    {selected.tokens ? (
                      <span>
                        {fmtCompact(selected.tokens.prompt_tokens || selected.tokens.input_tokens || 0)} in ·{" "}
                        {fmtCompact(selected.tokens.completion_tokens || selected.tokens.output_tokens || 0)} out
                      </span>
                    ) : null}
                    {selected.costUsd ? <span>{fmtCost(selected.costUsd)}</span> : null}
                    <span className="font-mono text-[10px]">{clockOf(selected.startedAt)}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {selected.sessionId && onOpenSession ? (
                    <Button size="sm" variant="outline" icon="forum" onClick={() => onOpenSession(selected.sessionId)}>
                      Open session
                    </Button>
                  ) : null}
                </div>
              </div>

              {selected.error ? (
                <div className="rounded-[10px] border border-danger/30 bg-danger/5 p-2.5 text-[11px] text-danger">
                  {selected.error}
                </div>
              ) : null}

              <div className="flex max-h-[520px] min-w-0 flex-col overflow-y-auto rounded-[10px] border border-border-subtle">
                {(selected.events || []).length === 0 ? (
                  <p className="p-4 text-xs text-text-muted">
                    Waiting for routing events… (the request is queued or the trace was not recorded)
                  </p>
                ) : (
                  (selected.events || []).map((event, index) => (
                    <div
                      key={index}
                      className={cn(
                        "flex items-start gap-2 border-b border-border-subtle px-2.5 py-1.5 last:border-b-0",
                        event.type === "error" && "bg-danger/5",
                        event.type === "fallback" && "bg-warning/5"
                      )}
                    >
                      <span className="w-14 shrink-0 pt-0.5 font-mono text-[10px] text-text-subtle">
                        {event.atIso ? clockOf(event.atIso) : ""}
                      </span>
                      <span className={cn("material-symbols-outlined pt-0.5 text-[14px]", EVENT_TONE[event.type] || "text-text-muted")}>
                        {EVENT_ICON[event.type] || "info"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block break-words text-[11px]", event.type === "error" ? "text-danger" : "text-text-main")}>
                          {event.message || event.type}
                        </span>
                        {event.error && event.message && !String(event.message).includes(event.error) ? (
                          <span className="block break-words text-[10px] text-danger/80">{event.error}</span>
                        ) : null}
                      </span>
                      {event.status != null ? (
                        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{event.status}</span>
                      ) : null}
                      {event.action ? (
                        <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">{event.action}</span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>

              <p className="text-[10px] text-text-muted">
                Events stream from the router as they happen: combo strategy, model resolution, pool/account selection, every failed
                attempt and its redirect, plus context/limit errors. Persisted requests show the trace recorded with the request.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
