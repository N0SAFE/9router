"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Drawer, Input, Select, Toggle } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { PROVIDER_MODELS } from "@/shared/constants/models";
import { cn } from "@/shared/utils/cn";
import {
  DAY_LABELS,
  ENDPOINT_OPTIONS,
  PERIODS,
  PERIOD_LABELS,
  POLICY_PRESETS,
  defaultPolicy,
  normalizePolicy,
  summarizePolicy,
  validatePolicy,
} from "@/lib/keys/policy.js";

const TABS = [
  { id: "access", label: "Access", icon: "shield" },
  { id: "budgets", label: "Budgets", icon: "savings" },
  { id: "limits", label: "Limits", icon: "speed" },
  { id: "features", label: "Features", icon: "tune" },
  { id: "content", label: "Content", icon: "rule" },
  { id: "schedule", label: "Schedule & IP", icon: "schedule" },
  { id: "json", label: "JSON", icon: "data_object" },
];

const PERIOD_OPTIONS = PERIODS.map((period) => ({ value: period, label: PERIOD_LABELS[period] }));

function fmtNumber(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString();
}

function fmtCost(value) {
  if (value === null || value === undefined) return "—";
  return `$${Number(value).toFixed(Number(value) < 1 ? 4 : 2)}`;
}

/* ------------------------------ list editor ------------------------------ */

function TagRuleEditor({ label, rule, onChange, options = [], placeholder = "Add entry…" }) {
  const [draft, setDraft] = useState("");
  const list = rule?.list || [];

  const add = (value) => {
    const entry = String(value || "").trim();
    if (!entry || list.includes(entry)) return;
    onChange({ ...rule, list: [...list, entry] });
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text-main">{label}</span>
        <select
          value={rule?.mode || "all"}
          onChange={(event) => onChange({ ...rule, mode: event.target.value })}
          className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-text-main"
        >
          <option value="all">Allow everything</option>
          <option value="allow">Only these</option>
          <option value="deny">Everything except these</option>
        </select>
      </div>

      {(rule?.mode || "all") !== "all" && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {list.length === 0 && <span className="text-xs text-text-subtle">No entries yet.</span>}
            {list.map((entry) => (
              <span key={entry} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-main">
                <span className="font-mono">{entry}</span>
                <button
                  type="button"
                  onClick={() => onChange({ ...rule, list: list.filter((item) => item !== entry) })}
                  className="text-text-muted hover:text-danger"
                >
                  <span className="material-symbols-outlined text-[13px]">close</span>
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={draft}
              list={`rule-options-${label.replace(/\s+/g, "-")}`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add(draft);
                }
              }}
              placeholder={placeholder}
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-xs text-text-main placeholder:text-text-subtle"
            />
            <datalist id={`rule-options-${label.replace(/\s+/g, "-")}`}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </datalist>
            <Button size="sm" variant="outline" onClick={() => add(draft)} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
          <p className="text-[11px] text-text-subtle">
            Wildcards allowed, e.g. <code>claude-*</code> or <code>openrouter/*</code>.
          </p>
        </>
      )}
    </div>
  );
}

/* ----------------------------- budget editor ----------------------------- */

function BudgetFields({ rule, onChange }) {
  const set = (patch) => onChange({ ...rule, ...patch });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-0.5 text-[11px] text-text-muted">
        Tokens
        <input
          type="number"
          min="0"
          value={rule.tokens ?? ""}
          onChange={(event) => set({ tokens: event.target.value === "" ? null : Number(event.target.value) })}
          placeholder="unlimited"
          className="h-8 w-28 rounded-lg border border-border bg-surface px-2 text-xs text-text-main"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-[11px] text-text-muted">
        Cost $
        <input
          type="number"
          min="0"
          step="0.01"
          value={rule.costUsd ?? ""}
          onChange={(event) => set({ costUsd: event.target.value === "" ? null : Number(event.target.value) })}
          placeholder="unlimited"
          className="h-8 w-24 rounded-lg border border-border bg-surface px-2 text-xs text-text-main"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-[11px] text-text-muted">
        % of key budget
        <input
          type="number"
          min="1"
          max="100"
          value={rule.percentOfBudget ?? ""}
          onChange={(event) => set({ percentOfBudget: event.target.value === "" ? null : Number(event.target.value) })}
          placeholder="—"
          className="h-8 w-28 rounded-lg border border-border bg-surface px-2 text-xs text-text-main"
        />
      </label>
      {rule.percentOfQuota !== undefined && (
        <label className="flex flex-col gap-0.5 text-[11px] text-text-muted">
          % of plan quota
          <input
            type="number"
            min="1"
            max="100"
            value={rule.percentOfQuota ?? ""}
            onChange={(event) => set({ percentOfQuota: event.target.value === "" ? null : Number(event.target.value) })}
            placeholder="—"
            className="h-8 w-28 rounded-lg border border-border bg-surface px-2 text-xs text-text-main"
          />
        </label>
      )}
      <label className="flex flex-col gap-0.5 text-[11px] text-text-muted">
        Period
        <select
          value={rule.period || "month"}
          onChange={(event) => set({ period: event.target.value })}
          className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-text-main"
        >
          {PERIOD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function usageForScope(usage, scope, key, period) {
  const bucket = usage?.periods?.[period];
  if (!bucket) return null;
  if (scope === "total") return bucket.total;
  if (scope === "provider") return bucket.byProvider?.[key] || null;
  if (scope === "model") return bucket.byModel?.[key] || null;
  if (scope === "connection") return bucket.byConnection?.[key] || null;
  return null;
}

function UsageBar({ label, used, limit, unit = "tokens", periodLabel }) {
  if (limit === null || limit === undefined) {
    return (
      <div className="flex items-center justify-between text-[11px] text-text-muted">
        <span>{label}</span>
        <span>{unit === "usd" ? fmtCost(used) : fmtNumber(used)} used (no limit)</span>
      </div>
    );
  }
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = percent >= 100 ? "bg-danger" : percent >= 80 ? "bg-warning" : "bg-emerald-500";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-muted">
          {label} <span className="text-text-subtle">{periodLabel}</span>
        </span>
        <span className={cn("font-mono tabular-nums", percent >= 100 ? "text-danger" : "text-text-main")}>
          {unit === "usd" ? fmtCost(used) : fmtNumber(used)} / {unit === "usd" ? fmtCost(limit) : fmtNumber(limit)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/* --------------------------------- drawer -------------------------------- */

export default function KeyAccessDrawer({ keyRow, isOpen, onClose, onSaved }) {
  const [policy, setPolicy] = useState(() => normalizePolicy(keyRow?.policies));
  const [tab, setTab] = useState("access");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [combos, setCombos] = useState([]);
  const [connections, setConnections] = useState([]);
  const [jsonDraft, setJsonDraft] = useState("");
  const [budgetScope, setBudgetScope] = useState("provider");
  const [budgetKey, setBudgetKey] = useState("");

  useEffect(() => {
    if (!keyRow) return;
    // Reset the editor when the drawer switches to another key.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPolicy(normalizePolicy(keyRow.policies));
    setError("");
    setSavedMessage("");
  }, [keyRow]);

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/combos", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setCombos((data?.combos || data || []).map((combo) => combo.name).filter(Boolean)))
      .catch(() => {});
    fetch("/api/providers", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setConnections(data?.connections || []))
      .catch(() => {});
  }, [isOpen]);

  const loadUsage = useCallback(async () => {
    if (!keyRow?.id) return;
    setUsageLoading(true);
    try {
      const response = await fetch(`/api/keys/${keyRow.id}/policy-usage`, { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setUsage(data.usage);
    } catch {
      // usage panel simply stays empty
    } finally {
      setUsageLoading(false);
    }
  }, [keyRow]);

  useEffect(() => {
    if (isOpen && tab === "budgets") {
      // Loading the usage snapshot is a side effect of opening the tab.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadUsage();
    }
  }, [isOpen, tab, loadUsage]);

  useEffect(() => {
    // Keep the JSON editor in sync with the form when the tab is opened.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "json") setJsonDraft(JSON.stringify(policy, null, 2));
  }, [tab, policy]);

  const providerOptions = useMemo(
    () =>
      Object.values(AI_PROVIDERS)
        .filter((provider) => !provider.hidden)
        .map((provider) => ({ value: provider.id, label: provider.name || provider.id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    []
  );

  const modelOptions = useMemo(() => {
    const out = [];
    for (const [alias, models] of Object.entries(PROVIDER_MODELS || {})) {
      for (const model of models || []) {
        out.push({ value: `${alias}/${model.id}`, label: `${alias}/${model.id}` });
      }
    }
    return out.slice(0, 3000);
  }, []);

  const summaryLines = useMemo(() => summarizePolicy(policy), [policy]);

  const patch = (updater) => {
    setPolicy((current) => normalizePolicy(typeof updater === "function" ? updater(current) : { ...current, ...updater }));
    setSavedMessage("");
  };

  const setBudget = (scope, key, rule) => {
    patch((current) => {
      const budgets = {
        total: current.budgets.total,
        perProvider: { ...current.budgets.perProvider },
        perModel: { ...current.budgets.perModel },
        perConnection: { ...current.budgets.perConnection },
      };
      if (scope === "total") budgets.total = rule;
      else if (scope === "provider") {
        if (rule) budgets.perProvider[key] = rule;
        else delete budgets.perProvider[key];
      } else if (scope === "model") {
        if (rule) budgets.perModel[key] = rule;
        else delete budgets.perModel[key];
      } else if (scope === "connection") {
        if (rule) budgets.perConnection[key] = rule;
        else delete budgets.perConnection[key];
      }
      return { ...current, budgets };
    });
  };

  const save = async () => {
    if (!keyRow?.id) return;
    setSaving(true);
    setError("");
    try {
      const { policy: validated, errors } = validatePolicy(policy);
      if (errors.length > 0) {
        setError(errors.join(" "));
        setSaving(false);
        return;
      }
      const response = await fetch(`/api/keys/${keyRow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policies: validated }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError([data.error, ...(data.details || [])].filter(Boolean).join(" "));
        return;
      }
      setPolicy(normalizePolicy(data.key?.policies));
      setSavedMessage("Policy saved.");
      onSaved?.(data.key);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (presetId) => {
    const preset = POLICY_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) return;
    setPolicy(normalizePolicy(preset.build()));
    setSavedMessage("");
  };

  const budgetRows = useMemo(() => {
    const rows = [{ scope: "total", key: "", rule: policy.budgets.total }];
    for (const [key, rule] of Object.entries(policy.budgets.perProvider)) rows.push({ scope: "provider", key, rule });
    for (const [key, rule] of Object.entries(policy.budgets.perModel)) rows.push({ scope: "model", key, rule });
    for (const [key, rule] of Object.entries(policy.budgets.perConnection)) rows.push({ scope: "connection", key, rule });
    return rows;
  }, [policy]);

  const addBudgetRow = () => {
    const key = budgetKey.trim();
    if (!key) return;
    const rule = { tokens: null, costUsd: null, percentOfBudget: null, percentOfQuota: budgetScope === "provider" ? null : undefined, period: "month" };
    setBudget(budgetScope, key, budgetScope === "connection" ? rule : rule);
    setBudgetKey("");
  };

  const budgetKeyOptions =
    budgetScope === "provider"
      ? providerOptions
      : budgetScope === "connection"
        ? connections.map((connection) => ({
            value: connection.id,
            label: `${connection.provider} · ${connection.displayName || connection.name || connection.email || connection.id.slice(0, 8)}`,
          }))
        : modelOptions;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={`Access — ${keyRow?.name || ""}`} width="xl">
      <div className="flex h-full flex-col gap-4">
        {/* Header: enabled / dry-run / presets */}
        <div className="flex flex-col gap-3 rounded-[10px] border border-border-subtle bg-bg p-3">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Toggle checked={policy.enabled} onChange={(checked) => patch({ enabled: checked })} />
              <span className="font-medium">Restrict this key</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Toggle checked={policy.dryRun} onChange={(checked) => patch({ dryRun: checked })} disabled={!policy.enabled} />
              <span>Dry run (warn only)</span>
            </label>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-text-muted">When a limit is hit:</span>
              <select
                value={policy.onExceed.mode}
                onChange={(event) => patch({ onExceed: { ...policy.onExceed, mode: event.target.value } })}
                className="h-8 rounded-lg border border-border bg-surface px-2 text-xs"
                disabled={!policy.enabled}
              >
                <option value="block">Block the request</option>
                <option value="downgrade">Downgrade first</option>
                <option value="warn">Warn only</option>
              </select>
            </div>
          </div>

          {policy.enabled && policy.onExceed.mode === "downgrade" && (
            <TagRuleEditor
              label="Downgrade targets (tried in order)"
              rule={{ mode: "allow", list: policy.onExceed.downgradeTo.models }}
              onChange={(rule) => patch({ onExceed: { ...policy.onExceed, downgradeTo: { ...policy.onExceed.downgradeTo, models: rule.list } } })}
              options={modelOptions}
              placeholder="provider/model or combo name"
            />
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-text-muted">Presets:</span>
            {POLICY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.description}
                onClick={() => applyPreset(preset.id)}
                className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-main transition-colors hover:bg-surface-2"
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => patch(defaultPolicy())}
              className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-muted hover:bg-surface-2"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                tab === entry.id ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[14px]">{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1 overflow-y-auto pr-1">
          {tab === "access" && (
            <div className="flex flex-col gap-4">
              <TagRuleEditor
                label="Providers"
                rule={policy.access.providers}
                onChange={(rule) => patch({ access: { ...policy.access, providers: rule } })}
                options={providerOptions}
                placeholder="provider id"
              />
              <TagRuleEditor
                label="Models"
                rule={policy.access.models}
                onChange={(rule) => patch({ access: { ...policy.access, models: { ...policy.access.models, mode: rule.mode, list: rule.list } } })}
                options={modelOptions}
                placeholder="model or provider/model (wildcards ok)"
              />
              {Object.entries(policy.access.models.perProvider).map(([provider, rule]) => (
                <div key={provider} className="rounded-[10px] border border-border-subtle p-3">
                  <TagRuleEditor
                    label={`Models for ${provider}`}
                    rule={rule}
                    onChange={(next) =>
                      patch({
                        access: {
                          ...policy.access,
                          models: {
                            ...policy.access.models,
                            perProvider: { ...policy.access.models.perProvider, [provider]: next },
                          },
                        },
                      })
                    }
                    options={modelOptions}
                  />
                  <button
                    type="button"
                    className="mt-2 text-xs text-danger"
                    onClick={() => {
                      const perProvider = { ...policy.access.models.perProvider };
                      delete perProvider[provider];
                      patch({ access: { ...policy.access, models: { ...policy.access.models, perProvider } } });
                    }}
                  >
                    Remove per-provider override
                  </button>
                </div>
              ))}
              <TagRuleEditor label="Combos" rule={policy.access.combos} onChange={(rule) => patch({ access: { ...policy.access, combos: rule } })} options={combos.map((name) => ({ value: name, label: name }))} />
              <TagRuleEditor
                label="Endpoints"
                rule={policy.access.endpoints}
                onChange={(rule) => patch({ access: { ...policy.access, endpoints: rule } })}
                options={ENDPOINT_OPTIONS.map((endpoint) => ({ value: endpoint, label: endpoint }))}
              />
              <TagRuleEditor
                label="Connections (accounts)"
                rule={policy.access.connections}
                onChange={(rule) => patch({ access: { ...policy.access, connections: rule } })}
                options={connections.map((connection) => ({ value: connection.id, label: `${connection.provider} · ${connection.name || connection.id.slice(0, 8)}` }))}
              />
            </div>
          )}

          {tab === "budgets" && (
            <div className="flex flex-col gap-3">
              {budgetRows.map(({ scope, key, rule }) => {
                const usageRow = usageForScope(usage, scope, key, rule.period || "month");
                const label = scope === "total" ? "This key" : scope === "provider" ? `Provider ${key}` : scope === "model" ? `Model ${key}` : `Connection ${key}`;
                return (
                  <div key={`${scope}-${key}`} className="rounded-[10px] border border-border-subtle bg-bg p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-text-main">{label}</span>
                      {scope !== "total" && (
                        <button type="button" className="text-xs text-danger" onClick={() => setBudget(scope, key, null)}>
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="mt-2">
                      <BudgetFields scope={scope} rule={rule} onChange={(next) => setBudget(scope, key, next)} />
                    </div>
                    <div className="mt-3 flex flex-col gap-2">
                      {rule.tokens !== null && (
                        <UsageBar label="Tokens" used={usageRow?.tokens || 0} limit={rule.tokens} periodLabel={PERIOD_LABELS[rule.period]} />
                      )}
                      {rule.costUsd !== null && (
                        <UsageBar label="Cost" used={usageRow?.costUsd || 0} limit={rule.costUsd} unit="usd" periodLabel={PERIOD_LABELS[rule.period]} />
                      )}
                      {rule.percentOfBudget !== null && (
                        <p className="text-[11px] text-text-muted">
                          Share of this key&apos;s total token usage{usageRow?.tokens ? `: ${((usageRow.tokens / Math.max(1, usageForScope(usage, "total", "", rule.period)?.tokens || 1)) * 100).toFixed(0)}%` : ""} (limit {rule.percentOfBudget}%).
                        </p>
                      )}
                      {rule.percentOfQuota !== null && rule.percentOfQuota !== undefined && scope === "provider" && (
                        <p className="text-[11px] text-text-muted">
                          Live plan quota used: {usage?.liveQuota?.[key]?.usedPct !== null && usage?.liveQuota?.[key]?.usedPct !== undefined ? `${usage.liveQuota[key].usedPct.toFixed(1)}%` : "unavailable"} · limit {rule.percentOfQuota}% attribution.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}

              <div className="rounded-[10px] border border-dashed border-border p-3">
                <p className="text-sm font-medium text-text-main">Add a scoped budget</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    value={budgetScope}
                    onChange={(event) => setBudgetScope(event.target.value)}
                    className="h-8 rounded-lg border border-border bg-surface px-2 text-xs"
                  >
                    <option value="provider">Per provider</option>
                    <option value="model">Per model</option>
                    <option value="connection">Per connection</option>
                  </select>
                  <input
                    value={budgetKey}
                    list="budget-key-options"
                    onChange={(event) => setBudgetKey(event.target.value)}
                    placeholder={budgetScope === "provider" ? "provider id" : budgetScope === "model" ? "provider/model" : "connection id"}
                    className="h-8 w-64 rounded-lg border border-border bg-surface px-2 text-xs"
                  />
                  <datalist id="budget-key-options">
                    {budgetKeyOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </datalist>
                  <Button size="sm" variant="outline" onClick={addBudgetRow} disabled={!budgetKey.trim()}>
                    Add
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-surface-2/50 p-3 text-xs text-text-muted">
                <button type="button" className="inline-flex items-center gap-1 text-primary" onClick={loadUsage} disabled={usageLoading}>
                  <span className={cn("material-symbols-outlined text-[14px]", usageLoading && "animate-spin")}>refresh</span>
                  {usageLoading ? "Loading usage…" : "Refresh usage"}
                </button>
                {usage?.rate && (
                  <span>
                    Rate: {usage.rate.rpm}/min · {usage.rate.rph}/hour · {usage.concurrent} in flight
                  </span>
                )}
              </div>
            </div>
          )}

          {tab === "limits" && (
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label="Requests / minute"
                  type="number"
                  min="0"
                  value={policy.rateLimits.requestsPerMinute ?? ""}
                  onChange={(event) => patch({ rateLimits: { ...policy.rateLimits, requestsPerMinute: event.target.value === "" ? null : Number(event.target.value) } })}
                  placeholder="unlimited"
                />
                <Input
                  label="Requests / hour"
                  type="number"
                  min="0"
                  value={policy.rateLimits.requestsPerHour ?? ""}
                  onChange={(event) => patch({ rateLimits: { ...policy.rateLimits, requestsPerHour: event.target.value === "" ? null : Number(event.target.value) } })}
                  placeholder="unlimited"
                />
                <Input
                  label="Max concurrent"
                  type="number"
                  min="0"
                  value={policy.rateLimits.maxConcurrent ?? ""}
                  onChange={(event) => patch({ rateLimits: { ...policy.rateLimits, maxConcurrent: event.target.value === "" ? null : Number(event.target.value) } })}
                  placeholder="unlimited"
                />
                <Input
                  label="Max input tokens / request"
                  type="number"
                  min="0"
                  value={policy.requestCaps.maxInputTokens ?? ""}
                  onChange={(event) => patch({ requestCaps: { ...policy.requestCaps, maxInputTokens: event.target.value === "" ? null : Number(event.target.value) } })}
                  placeholder="unlimited"
                />
                <Input
                  label="Max output tokens / request"
                  type="number"
                  min="0"
                  value={policy.requestCaps.maxOutputTokens ?? ""}
                  onChange={(event) => patch({ requestCaps: { ...policy.requestCaps, maxOutputTokens: event.target.value === "" ? null : Number(event.target.value) } })}
                  placeholder="clamps requests asking more"
                />
                <Input
                  label="Max cost / request ($)"
                  type="number"
                  min="0"
                  step="0.01"
                  value={policy.requestCaps.maxCostUsd ?? ""}
                  onChange={(event) => patch({ requestCaps: { ...policy.requestCaps, maxCostUsd: event.target.value === "" ? null : Number(event.target.value) } })}
                  placeholder="unlimited"
                />
                <Input
                  label="Max prompt characters"
                  type="number"
                  min="0"
                  value={policy.requestCaps.maxPromptChars ?? ""}
                  onChange={(event) => patch({ requestCaps: { ...policy.requestCaps, maxPromptChars: event.target.value === "" ? null : Number(event.target.value) } })}
                  placeholder="unlimited"
                />
              </div>
              <p className="text-xs text-text-muted">
                Rate limits count every attempt; token/cost budgets count successful requests. Output caps clamp{" "}
                <code>max_tokens</code> instead of rejecting, so clients keep working.
              </p>
            </div>
          )}

          {tab === "features" && (
            <div className="flex flex-col gap-3">
              {[
                ["streaming", "Streaming responses"],
                ["tools", "Tool / function calling"],
                ["vision", "Image inputs"],
                ["reasoning", "Reasoning / thinking"],
                ["embeddings", "Embeddings endpoint"],
              ].map(([feature, label]) => (
                <label key={feature} className="flex items-center justify-between rounded-[10px] border border-border-subtle bg-bg px-3 py-2.5">
                  <span className="text-sm text-text-main">{label}</span>
                  <Toggle
                    checked={policy.features[feature] !== false}
                    onChange={(checked) => patch({ features: { ...policy.features, [feature]: checked } })}
                  />
                </label>
              ))}
            </div>
          )}

          {tab === "content" && (
            <div className="flex flex-col gap-4">
              <TagRuleEditor
                label="Blocked keywords"
                rule={{ mode: "deny", list: policy.content.blockedKeywords }}
                onChange={(rule) => patch({ content: { ...policy.content, blockedKeywords: rule.list } })}
                placeholder="keyword or /regex/"
              />
              <TagRuleEditor
                label="Required keywords"
                rule={{ mode: "allow", list: policy.content.requiredKeywords }}
                onChange={(rule) => patch({ content: { ...policy.content, requiredKeywords: rule.list } })}
                placeholder="keyword or /regex/"
              />
              <label className="flex items-center justify-between rounded-[10px] border border-border-subtle bg-bg px-3 py-2.5">
                <span className="text-sm text-text-main">Require a system message</span>
                <Toggle
                  checked={policy.content.requireSystemPrompt}
                  onChange={(checked) => patch({ content: { ...policy.content, requireSystemPrompt: checked } })}
                />
              </label>
            </div>
          )}

          {tab === "schedule" && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1.5 text-sm font-medium text-text-main">Allowed days</p>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_LABELS.map((label, index) => {
                    const active = policy.schedule.allowedDays.includes(index);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          patch({
                            schedule: {
                              ...policy.schedule,
                              allowedDays: active
                                ? policy.schedule.allowedDays.filter((day) => day !== index)
                                : [...policy.schedule.allowedDays, index].sort(),
                            },
                          })
                        }
                        className={cn(
                          "rounded-lg border px-2.5 py-1 text-xs font-medium",
                          active ? "border-primary bg-primary/10 text-primary" : "border-border text-text-muted"
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label="Start hour (0-23)"
                  type="number"
                  min="0"
                  max="23"
                  value={policy.schedule.allowedHours?.[0] ?? ""}
                  onChange={(event) =>
                    patch({
                      schedule: {
                        ...policy.schedule,
                        allowedHours:
                          event.target.value === "" ? null : [Number(event.target.value), policy.schedule.allowedHours?.[1] ?? 23],
                      },
                    })
                  }
                  placeholder="no limit"
                />
                <Input
                  label="End hour (1-24)"
                  type="number"
                  min="1"
                  max="24"
                  value={policy.schedule.allowedHours?.[1] ?? ""}
                  onChange={(event) =>
                    patch({
                      schedule: {
                        ...policy.schedule,
                        allowedHours:
                          event.target.value === "" ? null : [policy.schedule.allowedHours?.[0] ?? 0, Number(event.target.value)],
                      },
                    })
                  }
                  placeholder="no limit"
                />
                <Input
                  label="Timezone (IANA or auto)"
                  value={policy.schedule.timezone}
                  onChange={(event) => patch({ schedule: { ...policy.schedule, timezone: event.target.value || "auto" } })}
                />
              </div>
              <Input
                label="Expires at (ISO date)"
                value={policy.schedule.expiresAt || ""}
                onChange={(event) => patch({ schedule: { ...policy.schedule, expiresAt: event.target.value || null } })}
                placeholder="2026-12-31T00:00:00.000Z"
              />
              <TagRuleEditor
                label="IP allowlist"
                rule={{ mode: "allow", list: policy.network.ipAllowlist }}
                onChange={(rule) => patch({ network: { ipAllowlist: rule.list } })}
                placeholder="203.0.113.7 or 203.0.113.0/24"
              />
            </div>
          )}

          {tab === "json" && (
            <div className="flex flex-col gap-2">
              <textarea
                value={jsonDraft}
                onChange={(event) => setJsonDraft(event.target.value)}
                spellCheck={false}
                className="h-[50vh] w-full resize-none rounded-[10px] border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-text-main focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(jsonDraft);
                      const { policy: validated, errors } = validatePolicy(parsed);
                      if (errors.length > 0) {
                        setError(errors.join(" "));
                        return;
                      }
                      setPolicy(validated);
                      setError("");
                      setSavedMessage("JSON applied (not saved yet).");
                    } catch (err) {
                      setError(`Invalid JSON: ${err.message}`);
                    }
                  }}
                >
                  Apply JSON
                </Button>
                <span className="text-[11px] text-text-muted">Paste or export the policy. “Apply” validates before saving.</span>
              </div>
            </div>
          )}
        </div>

        {/* Plain-English summary */}
        <div className="rounded-[10px] border border-border-subtle bg-bg p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">Effective policy</p>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {summaryLines.map((line, index) => (
              <li key={index} className="flex items-start gap-1.5 text-xs text-text-muted">
                <span className="material-symbols-outlined text-[13px] text-primary">chevron_right</span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        {error ? <p className="text-xs text-danger">{error}</p> : null}
        {savedMessage ? <p className="text-xs text-emerald-500">{savedMessage}</p> : null}

        <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
          <Badge variant={policy.enabled ? (policy.dryRun ? "info" : "primary") : "neutral"} size="sm" dot>
            {policy.enabled ? (policy.dryRun ? "Dry run" : "Enforcing") : "Unrestricted"}
          </Badge>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button icon="save" loading={saving} onClick={save}>Save policy</Button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
