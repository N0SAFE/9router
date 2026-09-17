"use client";

import { useCallback, useMemo, useState } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import { cn } from "@/shared/utils/cn";
import TokenFlowBar from "./TokenFlowBar";
import { fmt, fmtCompact, fmtCost, fmtPct, fmtTime } from "./format";

const SEVERITY_VARIANT = { high: "error", medium: "warning", low: "info" };
const SEVERITY_ICON = { high: "error", medium: "warning", low: "lightbulb" };

function wasteVariant(score) {
  if (score >= 60) return "error";
  if (score >= 30) return "warning";
  return "success";
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function StatTile({ icon, label, value, sub, accent }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-border-subtle bg-bg p-3">
      <div className="flex items-center gap-1.5 text-text-muted">
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
        <span className="truncate text-[10px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className={cn("mt-1.5 font-mono text-lg font-semibold tabular-nums leading-none", accent || "text-text-main")}>{value}</p>
      {sub && <p className="mt-1 truncate text-[11px] text-text-muted">{sub}</p>}
    </div>
  );
}

function DimensionChips({ dimensions }) {
  const groups = [
    { key: "providers", icon: "dns" },
    { key: "models", icon: "model_training" },
    { key: "accounts", icon: "account_circle" },
  ].filter((group) => (dimensions?.[group.key] || []).length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {groups.flatMap((group) =>
        (dimensions[group.key] || []).slice(0, 4).map((entry) => (
          <span
            key={`${group.key}-${entry.name}`}
            className="inline-flex max-w-[220px] items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted"
            title={`${group.key}: ${entry.name}`}
          >
            <span className="material-symbols-outlined text-[11px]">{group.icon}</span>
            <span className="truncate font-mono">{entry.name}</span>
            <span className="text-text-subtle">{entry.count}×</span>
          </span>
        ))
      )}
    </div>
  );
}

function LoadingInsights() {
  return (
    <Card padding="md">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-[10px] bg-surface-2" />
        ))}
      </div>
    </Card>
  );
}

export default function UsageInsights({ insights, loading, providerName, onSelectOffender, period = "7d", filters = {} }) {
  const [promptBusy, setPromptBusy] = useState(null); // pattern id | "all" | null
  const [promptDone, setPromptDone] = useState(null); // pattern id | "all" | request id
  const [promptError, setPromptError] = useState("");
  const [payloadHint, setPayloadHint] = useState(false);
  const [preview, setPreview] = useState(null); // { title, text, meta }

  const o = insights?.overview || {};
  const patterns = useMemo(() => insights?.patterns || [], [insights]);
  const offenders = insights?.offenders || [];
  const hasData = (o.requests || 0) > 0;
  const successRate = o.requests > 0 ? o.successes / o.requests : 0;

  const promptQuery = useCallback(
    (extra = {}) => {
      const params = new URLSearchParams({ period: period || "7d", ...extra });
      for (const [key, value] of Object.entries(filters || {})) {
        if (value) params.set(key, value);
      }
      return params.toString();
    },
    [period, filters]
  );

  const fetchPrompt = useCallback(
    async (extra) => {
      const response = await fetch(`/api/usage/insights/fix-prompt?${promptQuery(extra)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to build the fix prompt");
      }
      return payload;
    },
    [promptQuery]
  );

  const copyText = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleCopyPrompt = useCallback(
    async (pattern, { previewOnly = false } = {}) => {
      setPromptBusy(pattern.id);
      setPromptError("");
      try {
        const payload = await fetchPrompt({ pattern: pattern.id });
        if (payload.meta && payload.meta.rawPayloads === false) setPayloadHint(true);
        const copied = previewOnly ? false : await copyText(payload.prompt);
        if (!copied) {
          setPreview({
            title: `${pattern.title} — fix prompt`,
            text: payload.prompt,
            meta: payload.meta,
          });
        } else {
          setPromptDone(pattern.id);
          setTimeout(() => setPromptDone((current) => (current === pattern.id ? null : current)), 2500);
        }
      } catch (error) {
        setPromptError(String(error?.message || error));
      } finally {
        setPromptBusy(null);
      }
    },
    [fetchPrompt, copyText]
  );

  const handleCopyAll = useCallback(async () => {
    if (patterns.length === 0) return;
    setPromptBusy("all");
    setPromptError("");
    try {
      const parts = [`# 9Router token-leak fix bundle — ${patterns.length} pattern(s)`];
      let bytes = 0;
      let anyRaw = false;
      for (const pattern of patterns) {
        const payload = await fetchPrompt({ pattern: pattern.id });
        bytes += payload.prompt?.length || 0;
        anyRaw = anyRaw || Boolean(payload.meta?.rawPayloads);
        parts.push("---", "", payload.prompt || "");
      }
      if (!anyRaw) setPayloadHint(true);
      const text = parts.join("\n");
      const copied = await copyText(text);
      if (!copied) {
        setPreview({ title: `All fix prompts (${patterns.length})`, text, meta: { bytes } });
      } else {
        setPromptDone("all");
        setTimeout(() => setPromptDone((current) => (current === "all" ? null : current)), 2500);
      }
    } catch (error) {
      setPromptError(String(error?.message || error));
    } finally {
      setPromptBusy(null);
    }
  }, [patterns, fetchPrompt, copyText]);

  const handleOffenderPrompt = useCallback(
    async (row) => {
      if (!row?.id) return;
      setPromptBusy(row.id);
      setPromptError("");
      try {
        const payload = await fetchPrompt({ requestId: row.id });
        if (payload.meta && payload.meta.rawPayloads === false) setPayloadHint(true);
        const copied = await copyText(payload.prompt);
        if (!copied) {
          setPreview({ title: `Request fix prompt — ${row.model || row.id}`, text: payload.prompt, meta: payload.meta });
        } else {
          setPromptDone(row.id);
          setTimeout(() => setPromptDone((current) => (current === row.id ? null : current)), 2500);
        }
      } catch (error) {
        setPromptError(String(error?.message || error));
      } finally {
        setPromptBusy(null);
      }
    },
    [fetchPrompt, copyText]
  );

  if (loading && !insights) return <LoadingInsights />;
  if (!insights) return null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Token ledger — the signature panel */}
      <Card padding="md" className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-brand-500">savings</span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Avoidable this window</span>
            </div>
            <div className="mt-1.5 flex items-end gap-2">
              <span className="font-mono text-4xl font-semibold leading-none tabular-nums text-brand-500">
                {fmtCompact(o.potentialSavingsTokens)}
              </span>
              <span className="pb-0.5 text-sm text-text-muted">tokens</span>
            </div>
            <p className="mt-1.5 text-sm text-text-muted">
              ≈ {fmtCost(o.potentialSavingsUsd)} of estimated spend. Copy a fix prompt per pattern and hand it to an LLM.
            </p>
            <TokenFlowBar
              className="mt-3"
              input={o.inputTokens}
              cached={o.cachedTokens}
              output={o.outputTokens}
              potential={o.potentialSavingsTokens}
              height="h-2.5"
              showLegend
            />
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <StatTile
              icon="bolt"
              label="Requests"
              value={fmt(o.requests)}
              sub={hasData ? `${fmtPct(successRate)} success · ${o.failures} failed` : "no traffic yet"}
            />
            <StatTile
              icon="login"
              label="Input"
              value={fmtCompact(o.inputTokens)}
              sub={`${fmtPct(o.cacheHitRate)} from cache`}
            />
            <StatTile
              icon="logout"
              label="Output"
              value={fmtCompact(o.outputTokens)}
              sub={o.reasoningTokens > 0 ? `${fmtCompact(o.reasoningTokens)} reasoning` : "no reasoning tokens"}
            />
            <StatTile
              icon="payments"
              label="Est. cost"
              value={fmtCost(o.totalCost)}
              sub={o.p95LatencyMs > 0 ? `p95 ${o.p95LatencyMs}ms` : "latency n/a"}
              accent="text-warning"
            />
          </div>
        </div>
      </Card>

      {/* Detected patterns */}
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-text-muted">travel_explore</span>
            <h3 className="text-sm font-semibold text-text-main">Token leaks detected</h3>
            <Badge variant={patterns.length > 0 ? "warning" : "success"} size="sm" dot>
              {patterns.length > 0 ? `${patterns.length} pattern${patterns.length > 1 ? "s" : ""}` : "all clear"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {promptError ? <span className="text-[11px] text-danger">{promptError}</span> : null}
            {!promptError && promptDone === "all" ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
                <span className="material-symbols-outlined text-[14px]">check_circle</span>
                Copied all prompts
              </span>
            ) : null}
            {payloadHint ? (
              <span className="text-[11px] text-warning" title="Enable Observability in Settings so request payloads are stored">
                no raw payloads stored — enable Observability to include them
              </span>
            ) : null}
            {patterns.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                icon={promptDone === "all" ? "check" : "content_copy"}
                loading={promptBusy === "all"}
                disabled={promptBusy !== null && promptBusy !== "all"}
                onClick={handleCopyAll}
              >
                {promptDone === "all" ? "Copied" : "Copy all prompts"}
              </Button>
            )}
          </div>
        </div>

        {!hasData ? (
          <Card padding="md">
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <span className="material-symbols-outlined text-[32px] text-text-subtle">query_stats</span>
              <p className="text-sm text-text-main">No requests in this window yet.</p>
              <p className="max-w-md text-sm text-text-muted">
                Send some traffic, then come back. Insights need at least one completed request.
              </p>
            </div>
          </Card>
        ) : patterns.length === 0 ? (
          <Card padding="md" className="border-emerald-500/25">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[24px] text-emerald-500">verified</span>
              <div>
                <p className="text-sm font-medium text-text-main">No token leaks found in this window.</p>
                <p className="text-sm text-text-muted">
                  Keep Headroom and RTK enabled, and keep prompts cache-stable to stay here.
                </p>
              </div>
            </div>
          </Card>
        ) : (
          <div className="grid min-w-0 gap-2.5 lg:grid-cols-2">
            {patterns.map((p) => (
              <Card key={p.id} padding="sm" className="min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn(
                      "material-symbols-outlined text-[18px]",
                      p.severity === "high" ? "text-danger" : p.severity === "medium" ? "text-warning" : "text-info"
                    )}>
                      {SEVERITY_ICON[p.severity] || "lightbulb"}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-main">{p.title}</p>
                      <p className="text-[11px] text-text-muted">
                        {p.occurrences} request{p.occurrences > 1 ? "s" : ""}
                        {p.wastedTokens > 0 ? ` · ~${fmtCompact(p.wastedTokens)} tokens` : ""}
                        {p.wastedUsd > 0 ? ` · ${fmtCost(p.wastedUsd)}` : ""}
                      </p>
                    </div>
                  </div>
                  <Badge variant={SEVERITY_VARIANT[p.severity] || "default"} size="sm">
                    {p.severity}
                  </Badge>
                </div>

                <DimensionChips dimensions={p.dimensions} />

                <p className="mt-2.5 text-sm text-text-muted">{p.explanation}</p>
                <div className="mt-2.5 flex items-start gap-2 rounded-[10px] bg-brand-500/5 p-2.5">
                  <span className="material-symbols-outlined text-[16px] text-brand-500">tips_and_updates</span>
                  <p className="text-xs leading-relaxed text-text-main">{p.tip}</p>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={promptDone === p.id ? "check" : "content_copy"}
                    loading={promptBusy === p.id}
                    disabled={promptBusy !== null && promptBusy !== p.id}
                    onClick={() => handleCopyPrompt(p)}
                  >
                    {promptDone === p.id ? "Copied" : "Copy fix prompt"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="visibility"
                    disabled={promptBusy !== null}
                    onClick={() => handleCopyPrompt(p, { previewOnly: true })}
                  >
                    Preview
                  </Button>
                  <span className="text-[11px] text-text-subtle">full context incl. raw payloads</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Biggest offenders */}
      {offenders.length > 0 && (
        <Card padding="none" className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-3.5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-text-muted">local_fire_department</span>
              <h3 className="text-sm font-semibold text-text-main">Most wasteful requests</h3>
            </div>
            <span className="text-[11px] text-text-muted">ranked by avoidable tokens</span>
          </div>
          <ul className="divide-y divide-border-subtle">
            {offenders.map((row, index) => (
              <li key={`${row.id || index}`} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                <span className="w-5 font-mono text-xs text-text-subtle tabular-nums">{index + 1}</span>
                <div className="min-w-[180px] flex-1">
                  <p className="truncate font-mono text-xs text-text-main">{row.model || "unknown"}</p>
                  <p className="truncate text-[11px] text-text-muted">
                    {providerName ? providerName(row.provider) : row.provider} · {fmtTime(row.timestamp)}
                    {row.status !== "success" ? ` · ${row.status}` : ""}
                  </p>
                </div>
                <TokenFlowBar
                  className="hidden min-w-[140px] flex-1 sm:flex"
                  input={Math.max(0, (row.tokens?.prompt_tokens || row.tokens?.input_tokens || 0))}
                  cached={row.tokens?.cached_tokens || row.tokens?.cache_read_input_tokens || 0}
                  output={row.tokens?.completion_tokens || 0}
                  potential={row.wastedTokens}
                  height="h-1.5"
                />
                <div className="flex items-center gap-1.5">
                  <Badge variant={wasteVariant(row.wasteScore)} size="sm">
                    {row.wasteScore}% waste
                  </Badge>
                  <span className="font-mono text-[11px] text-text-muted tabular-nums">~{fmtCompact(row.wastedTokens)}</span>
                  <Button variant="ghost" size="sm" onClick={() => onSelectOffender?.(row)}>
                    Inspect
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={promptDone === row.id ? "check" : "content_copy"}
                    loading={promptBusy === row.id}
                    disabled={!row.id || (promptBusy !== null && promptBusy !== row.id)}
                    onClick={() => handleOffenderPrompt(row)}
                    title="Copy a fix prompt scoped to this request"
                  >
                    {promptDone === row.id ? "Copied" : "Prompt"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        isOpen={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.title || "Fix prompt"}
        size="full"
        footer={
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-text-muted">
              {preview?.meta?.bytes ? fmtBytes(preview.meta.bytes) : ""}
              {preview?.meta?.samples ? ` · ${preview.meta.samples} sample(s)` : ""}
              {preview?.meta?.rawPayloads ? " · raw payloads included" : ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                icon="content_copy"
                onClick={async () => {
                  if (preview?.text) await copyText(preview.text);
                }}
              >
                Copy
              </Button>
              <Button variant="primary" size="sm" onClick={() => setPreview(null)}>
                Close
              </Button>
            </div>
          </div>
        }
      >
        <textarea
          readOnly
          value={preview?.text || ""}
          className="h-[60vh] w-full resize-none rounded-[10px] border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-text-main focus:outline-none"
        />
      </Modal>
    </div>
  );
}
