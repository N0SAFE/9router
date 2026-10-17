"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import ModelSelectModal from "./ModelSelectModal";

// Local upgrade agent (opencode) driven from the sidebar: pick the model the
// agent runs with, start the run, then follow the log/report. The model comes
// straight from this router's own catalog so the value is one `opencode run`
// can actually reach.
//
// ponytail: "resume" reopens this watcher over /api/upgrade/status (the run is
// tracked by pid + log file). It does not reattach the opencode CLI session;
// add `opencode run --session <id>` if dying mid-run and continuing is needed.

const STATUS_STYLES = {
  running: "bg-blue-500/10 text-blue-500",
  finished: "bg-green-500/10 text-green-500",
  stopped: "bg-orange-500/10 text-orange-500",
  idle: "bg-surface-2 text-text-muted",
};

export default function UpgradeAgentModal({ isOpen, onClose, onStarted }) {
  const [state, setState] = useState(null);
  const [model, setModel] = useState("");
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/upgrade/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setState(data);
      // Keep the last model the user picked (or started a run with).
      setModel((current) => current || data.model || "");
    } catch {
      /* the dashboard stays usable when the agent state is unreadable */
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

  useEffect(() => {
    if (!isOpen) return;
    loadStatus();
    loadPickerSources();
  }, [isOpen, loadStatus, loadPickerSources]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const interval = setInterval(loadStatus, state?.running ? 3000 : 15000);
    return () => clearInterval(interval);
  }, [isOpen, state?.running, loadStatus]);

  const saveModel = async (value) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upgradeModel: value }),
      });
    } catch {
      /* the start call persists it again */
    }
  };

  const pickModel = (selected) => {
    const value = selected?.value || selected?.name || "";
    if (!value) return;
    setModel(value);
    saveModel(value);
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
      await loadStatus();
      onStarted?.();
      onClose();
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

  const running = state?.running === true;
  const status = running ? "running" : state?.status || "idle";
  const blocked = state?.installed === false
    ? "opencode CLI is not installed in this container"
    : state?.repoPresent === false
      ? `No git checkout at ${state?.repoPath || "/workspace/9router"}`
      : null;
  const canRun = !running && Boolean(model.trim()) && !blocked;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={running ? "Upgrade session" : "Upgrade by agent"}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {running ? "Close" : "Cancel"}
            </Button>
            {running ? (
              <Button variant="outline" icon="stop" onClick={stop} disabled={busy} loading={busy}>
                Stop
              </Button>
            ) : (
              <Button icon="rocket_launch" onClick={start} disabled={busy || !canRun} loading={busy}>
                Start upgrade
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className={`px-2 py-1 rounded-md text-xs font-medium ${STATUS_STYLES[status] || STATUS_STYLES.idle}`}>
              {status}
            </span>
            {state?.startedAt && (
              <span className="text-xs text-text-muted">
                {new Date(state.startedAt).toLocaleString()}
                {state.finishedAt ? ` → ${new Date(state.finishedAt).toLocaleString()}` : ""}
                {state.exitCode !== null && state.exitCode !== undefined ? ` (exit ${state.exitCode})` : ""}
              </span>
            )}
          </div>

          {running ? (
            <p className="text-sm text-text-muted">
              The agent is rebasing this fork onto upstream with{" "}
              <code className="px-1 rounded bg-surface-2 text-text-main">{state?.model || model}</code>.
              It rebuilds the stack as its last step. You can close this and come back from the sidebar.
            </p>
          ) : (
            <div>
              <p className="text-xs font-medium text-text-muted mb-2">Model the agent runs with</p>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] border border-border bg-surface hover:border-brand-500/40 transition-colors text-left cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px] text-text-muted">psychology</span>
                <span className={`flex-1 min-w-0 truncate text-sm ${model ? "text-text-main" : "text-text-muted"}`}>
                  {model || "Select a model…"}
                </span>
                <span className="material-symbols-outlined text-[18px] text-text-muted">expand_more</span>
              </button>
              {blocked && <p className="text-xs text-red-500 mt-2">{blocked}</p>}
            </div>
          )}

          {message && (
            <p className={`text-xs ${message.type === "error" ? "text-red-500" : "text-green-500"}`}>
              {message.text}
            </p>
          )}

          {state?.startedAt && (state?.logTail || state?.report) && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowLog((v) => !v)}
                className="text-xs font-medium text-text-muted hover:text-text-main cursor-pointer"
              >
                {showLog ? "Hide output" : "Show output"}
              </button>
              {showLog && (
                <div className="space-y-2">
                  <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap break-words">
                    {state.logTail || "(no output yet)"}
                  </pre>
                  {state.report && (
                    <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap break-words">
                      {state.report}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <ModelSelectModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={pickModel}
        selectedModel={model}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Select the upgrade model"
      />
    </>
  );
}

UpgradeAgentModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onStarted: PropTypes.func,
};
