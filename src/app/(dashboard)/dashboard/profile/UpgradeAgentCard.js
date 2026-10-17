"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, ModelSelectModal } from "@/shared/components";

// Local upgrade agent: starts `opencode run` against the mounted fork checkout
// so the fork can be rebased onto upstream without leaving the dashboard.
// Visible only in self-hosted builds (the API is a local-only route).

const STATUS_STYLES = {
  running: "bg-blue-500/10 text-blue-500",
  finished: "bg-green-500/10 text-green-500",
  stopped: "bg-orange-500/10 text-orange-500",
  idle: "bg-surface-2 text-text-muted",
};

export default function UpgradeAgentCard() {
  const [version, setVersion] = useState(null);
  const [state, setState] = useState(null);
  const [model, setModel] = useState("");
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [message, setMessage] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/upgrade/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setState(data);
      setModel((current) => current || data.model || "");
    } catch {
      /* dashboard stays usable when the agent state is unreadable */
    }
  }, []);

  const loadPickerSources = useCallback(async () => {
    try {
      const [provRes, aliasRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/models/alias", { cache: "no-store" }),
      ]);
      if (provRes.ok) {
        const data = await provRes.json();
        setActiveProviders((data.connections || []).filter((c) => c.isActive !== false));
      }
      if (aliasRes.ok) {
        const data = await aliasRes.json();
        setModelAliases(data.aliases || {});
      }
    } catch {
      /* picker falls back to the static registry */
    }
  }, []);

  const loadVersion = useCallback(async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (res.ok) setVersion(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadVersion();
    loadStatus();
    loadPickerSources();
  }, [loadStatus, loadVersion, loadPickerSources]);

  useEffect(() => {
    const interval = state?.running ? 3000 : 15000;
    pollRef.current = setInterval(loadStatus, interval);
    return () => clearInterval(pollRef.current);
  }, [state?.running, loadStatus]);

  const pickModel = async (selected) => {
    const value = selected?.value || selected?.name || "";
    if (!value) return;
    setModel(value);
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upgradeModel: value }),
      });
      if (!res.ok) throw new Error("Failed to save the upgrade model");
      setMessage({ type: "success", text: `Upgrade model set to ${value}` });
      await loadStatus();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/upgrade/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start the upgrade agent");
      setShowLog(true);
      setMessage({ type: "success", text: `Upgrade agent started with ${data.model}` });
      await loadStatus();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/upgrade/stop", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to stop the upgrade agent");
      setMessage({ type: "success", text: data.stopped ? "Upgrade agent stopped" : "Nothing to stop" });
      await loadStatus();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  };

  const hasUpdate = version?.hasUpdate === true;
  const running = state?.running === true;
  const status = running ? "running" : state?.status || "idle";
  const canRun = hasUpdate && !running && Boolean(model.trim()) && state?.installed !== false && state?.repoPresent !== false;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">rocket_launch</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base sm:text-lg font-semibold">Upgrade agent</h3>
          <p className="text-xs sm:text-sm text-text-muted">
            Rebases this fork onto upstream with opencode, following the upgrade skill.
          </p>
        </div>
        <span className={`px-2 py-1 rounded-md text-xs font-medium ${STATUS_STYLES[status] || STATUS_STYLES.idle}`}>
          {status}
        </span>
      </div>

      <div className="space-y-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">
              {hasUpdate
                ? `Update available: v${version?.currentVersion} → v${version?.latestVersion}`
                : version
                  ? `Up to date (v${version.currentVersion})`
                  : "Checking for updates…"}
            </p>
            <p className="text-xs sm:text-sm text-text-muted">
              {state?.installed === false
                ? "opencode CLI is not installed in this container"
                : state?.repoPresent === false
                  ? `No git checkout at ${state?.repoPath || "/workspace/9router"}`
                  : "Runs in the mounted checkout; commits locally and rebuilds the stack at the end"}
            </p>
          </div>
          {running && (
            <Button variant="outline" icon="stop" onClick={stop} disabled={busy}>
              Stop
            </Button>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex-1 flex items-center gap-2 px-3 py-2 rounded-[10px] border border-border bg-surface hover:border-brand-500/40 transition-colors text-left cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px] text-text-muted">psychology</span>
            <span className={`flex-1 min-w-0 truncate text-sm ${model ? "text-text-main" : "text-text-muted"}`}>
              {model || "Select the model for the upgrade agent…"}
            </span>
            <span className="material-symbols-outlined text-[18px] text-text-muted">expand_more</span>
          </button>
          <div className="flex gap-2 sm:self-auto">
            <Button icon="rocket_launch" onClick={start} disabled={busy || !canRun}>
              Run upgrade
            </Button>
          </div>
        </div>
        <p className="text-xs text-text-muted">
          Models and combos come straight from this router&apos;s catalog; the choice is saved automatically.
        </p>

        {!hasUpdate && version && (
          <p className="text-xs text-text-muted">
            The run button enables when a newer version is available; you can still start it from the API.
          </p>
        )}

        {message && (
          <p className={`text-xs sm:text-sm ${message.type === "error" ? "text-red-500" : "text-green-500"}`}>
            {message.text}
          </p>
        )}

        {(state?.logTail || state?.report) && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowLog((v) => !v)}
              className="text-xs font-medium text-text-muted hover:text-text"
            >
              {showLog ? "Hide output" : "Show output"}
            </button>
            {showLog && (
              <div className="space-y-2">
                <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap break-words">
                  {state.logTail || "(no output yet)"}
                </pre>
                {state.report && (
                  <div>
                    <p className="text-xs font-medium mb-1">Last report</p>
                    <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap break-words">
                      {state.report}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {state?.startedAt && (
          <p className="text-xs text-text-muted">
            Last run: {new Date(state.startedAt).toLocaleString()}
            {state.finishedAt ? ` → ${new Date(state.finishedAt).toLocaleString()}` : ""}
            {state.exitCode !== null && state.exitCode !== undefined ? ` (exit ${state.exitCode})` : ""}
          </p>
        )}
      </div>

      <ModelSelectModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={pickModel}
        selectedModel={model}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Select the upgrade model"
      />
    </Card>
  );
}
