"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const SERVER_DEFAULTS = {
  "ollama-local": "http://localhost:11434",
  llamacpp: "http://localhost:8080",
  vllm: "http://localhost:8000",
};

const SERVER_HINTS = {
  llamacpp: "Load a model by starting llama-server, e.g. `llama-server -hf ggml-org/gemma-3-4b-it-GGUF --port 8080`.",
  vllm: "Load a model by starting vLLM, e.g. `vllm serve Qwen/Qwen3-8B --port 8000`.",
  "ollama-local": "Install models below; they appear in the model picker as soon as the download finishes.",
};

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) {
    return "—";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/**
 * Local model manager for ollama-local / llama.cpp / vLLM:
 * - Ollama: installed models (size/date), pull-new-model combobox with live
 *   progress, delete, plus running models with VRAM usage and one-click unload.
 * - llama.cpp / vLLM: server status and the model(s) the server currently
 *   serves, with the command to load a different one.
 */
export default function LocalModelsPanel({ providerId, connections = [] }) {
  const isOllama = providerId === "ollama-local";
  const hostOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const connection of connections) {
      if (!connection || connection.isActive === false) {
        continue;
      }
      const baseUrl = connection.providerSpecificData?.baseUrl || "";
      const key = baseUrl || "__default__";
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      options.push({
        id: connection.id,
        label: `${connection.name || SERVER_DEFAULTS[providerId] || "server"}${baseUrl ? ` · ${baseUrl}` : ""}`,
        host: baseUrl,
      });
    }
    if (options.length === 0) {
      options.push({ id: "default", label: SERVER_DEFAULTS[providerId] || "default", host: "" });
    }
    return options;
  }, [connections, providerId]);
  const [selectedHostId, setSelectedHostId] = useState("");
  const selectedHost = hostOptions.find((option) => option.id === selectedHostId) || hostOptions[0];
  const host = selectedHost?.host || "";
  const isLocalHost =
    !host || /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(host);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [library, setLibrary] = useState([]);
  const [tags, setTags] = useState(["latest"]);
  const [modelInput, setModelInput] = useState("");
  const [tagInput, setTagInput] = useState("latest");
  const [pull, setPull] = useState(null);
  const [busyModel, setBusyModel] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [runModel, setRunModel] = useState("");
  const [runPort, setRunPort] = useState("");
  const [logs, setLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [starting, setStarting] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const pullAbortRef = useRef(null);
  const logsRef = useRef(null);
  const { copy } = useCopyToClipboard();

  const endpointHost = host || SERVER_DEFAULTS[providerId] || "";

  const refresh = useCallback(async () => {
    try {
      const url = isOllama
        ? `/api/local/ollama/status?host=${encodeURIComponent(host)}&connectionId=${encodeURIComponent(selectedHost?.id || "")}`
        : `/api/local/server/status?provider=${encodeURIComponent(providerId)}&baseUrl=${encodeURIComponent(host)}&connectionId=${encodeURIComponent(selectedHost?.id || "")}`;
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      setStatus(data);
      setLastUpdated(Date.now());
      setError(data.online ? "" : `Server not reachable at ${data.host || data.baseUrl || endpointHost}`);
    } catch (err) {
      setStatus(null);
      setError(String(err?.message || err));
    }
  }, [endpointHost, host, isOllama, providerId]);

  useEffect(() => {
    // Initial load; refresh() awaits its fetch before updating state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  // Keep the panel in sync with servers started/stopped outside the app.
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  const refreshLogs = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/local/server/logs?provider=${encodeURIComponent(providerId)}&lines=200`,
        { cache: "no-store" }
      );
      const data = await response.json();
      setLogs(typeof data.logs === "string" ? data.logs : "");
    } catch {
      setLogs("");
    }
  }, [providerId]);

  useEffect(() => {
    if (!showLogs) {
      return undefined;
    }
    // Initial tail; refreshLogs() awaits its fetch before updating state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshLogs();
    const timer = setInterval(refreshLogs, 3000);
    return () => clearInterval(timer);
  }, [refreshLogs, showLogs]);

  useEffect(() => {
    if (showLogs && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs, showLogs]);

  useEffect(() => {
    if (providerId !== "vllm") {
      return undefined;
    }
    let cancelled = false;
    fetch(`/api/local/server/metrics?provider=vllm&baseUrl=${encodeURIComponent(host)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          setMetrics(data.online ? data.metrics : null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMetrics(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [host, providerId, status?.online]);

  useEffect(() => {
    if (!isOllama) {
      return;
    }
    fetch("/api/local/ollama/library", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setLibrary(Array.isArray(data.models) ? data.models : []))
      .catch(() => setLibrary([]));
  }, [isOllama]);

  useEffect(() => {
    if (!isOllama || !modelInput.trim()) {
      return undefined;
    }
    const timer = setTimeout(() => {
      fetch(`/api/local/ollama/library?tags=${encodeURIComponent(modelInput.trim())}`)
        .then((response) => response.json())
        .then((data) => setTags(Array.isArray(data.tags) && data.tags.length ? data.tags : ["latest"]))
        .catch(() => setTags(["latest"]));
    }, 300);
    return () => clearTimeout(timer);
  }, [isOllama, modelInput]);

  const installModel = useMemo(() => {
    const base = modelInput.trim();
    if (!base) {
      return "";
    }
    const tag = tagInput.trim() || "latest";
    return base.includes(":") ? base : `${base}:${tag}`;
  }, [modelInput, tagInput]);

  const startPull = useCallback(async () => {
    if (!installModel || pull) {
      return;
    }
    setError("");
    setPull({ model: installModel, status: "starting", percent: 0, rate: null, eta: null });
    const controller = new AbortController();
    pullAbortRef.current = controller;
    const startedAt = Date.now();
    let lastCompleted = 0;
    try {
      const response = await fetch("/api/local/ollama/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, model: installModel }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Pull failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.error) {
            throw new Error(event.error);
          }
          const percent = Number.isFinite(event.total) && event.total > 0
            ? Math.round((Number(event.completed || 0) / event.total) * 100)
            : null;
          const elapsedSeconds = (Date.now() - startedAt) / 1000;
          setPull((previous) => {
            if (!previous) {
              return previous;
            }
            let rateText = previous.rate;
            let etaText = previous.eta;
            if (Number.isFinite(event.completed) && Number.isFinite(event.total) && elapsedSeconds > 0.5) {
              const bytesPerSecond = Number(event.completed) / elapsedSeconds;
              if (bytesPerSecond > 0) {
                rateText = `${formatBytes(bytesPerSecond)}/s`;
                const remaining = Number(event.total) - Number(event.completed);
                etaText = remaining > 0 ? formatDuration(remaining / bytesPerSecond) : "0s";
              }
            }
            lastCompleted = Number.isFinite(event.completed) ? Number(event.completed) : lastCompleted;
            return {
              ...previous,
              status: event.status || previous.status,
              percent: percent ?? previous.percent,
              rate: rateText,
              eta: etaText,
            };
          });
        }
      }

      setPull({ model: installModel, status: "done", percent: 100, rate: null, eta: null });
      setModelInput("");
      await refresh();
      setTimeout(() => setPull(null), 2500);
    } catch (err) {
      if (err?.name === "AbortError") {
        setPull(null);
        setError("Download cancelled");
      } else {
        setPull(null);
        setError(String(err?.message || err));
      }
    } finally {
      pullAbortRef.current = null;
    }
  }, [host, installModel, pull, refresh]);

  const cancelPull = useCallback(() => {
    pullAbortRef.current?.abort();
    pullAbortRef.current = null;
  }, []);

  const deleteModel = useCallback(async (model) => {
    if (!window.confirm(`Delete "${model}" from the local Ollama server?`)) {
      return;
    }
    setBusyModel(model);
    setError("");
    try {
      const response = await fetch("/api/local/ollama/models", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, model }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Delete failed");
      }
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusyModel("");
    }
  }, [host, refresh]);

  const unloadModel = useCallback(async (model) => {
    setBusyModel(model);
    setError("");
    try {
      const response = await fetch("/api/local/ollama/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, model }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Unload failed");
      }
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusyModel("");
    }
  }, [host, refresh]);

  const testModel = useCallback(async (model) => {
    setBusyModel(model);
    setError("");
    try {
      const response = await fetch("/api/local/ollama/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, model }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Test failed");
      }
      setTestResult({ model, ms: data.ms, response: data.response });
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusyModel("");
    }
  }, [host, refresh]);

  const models = Array.isArray(status?.models) ? status.models : [];
  const running = Array.isArray(status?.running) ? status.running : [];
  const online = Boolean(status?.online);
  const serverModel = !isOllama && models.length > 0 ? models[0] : null;
  const processState = status?.process || null;
  const processSource = processState?.source || null;
  const effectiveModel = runModel || processState?.model || "";
  const effectivePort = runPort || (processState?.port ? String(processState.port) : "");
  const filteredModels = models.filter((model) =>
    !modelFilter.trim() ||
    String(model.name || model.model || "").toLowerCase().includes(modelFilter.trim().toLowerCase())
  );
  const processLabel = !processState?.running
    ? "stopped"
    : processSource === "managed"
      ? `running · app pid ${processState.pid}`
      : processSource === "system"
        ? `running · system pid ${processState.pid}`
        : "running · external";

  const startServer = useCallback(async () => {
    setStarting(true);
    setError("");
    try {
      const response = await fetch("/api/local/server/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          model: isOllama ? undefined : effectiveModel.trim() || undefined,
          port: /^\d+$/.test(effectivePort) ? Number(effectivePort) : undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to start the server");
      }
      setShowLogs(true);
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setStarting(false);
    }
  }, [effectiveModel, effectivePort, isOllama, providerId, refresh]);

  const stopServer = useCallback(async () => {
    setStarting(true);
    setError("");
    try {
      const response = await fetch("/api/local/server/status", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to stop the server");
      }
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setStarting(false);
    }
  }, [providerId, refresh]);

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">
            {isOllama ? "Local Models" : "Local Server"}
          </h2>
          <p className="break-all text-sm text-text-muted">
            {status?.host || status?.baseUrl || endpointHost}
            {online ? ` · ${models.length} model${models.length === 1 ? "" : "s"}` : ""}
            {isOllama && status?.version ? ` · v${status.version}` : ""}
          </p>
          {hostOptions.length > 1 && (
            <select
              value={selectedHost?.id || ""}
              onChange={(event) => setSelectedHostId(event.target.value)}
              className="mt-2 w-full max-w-sm rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-main outline-none focus:border-brand-500/50"
            >
              {hostOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${online ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-red-500/10 text-red-600 dark:text-red-400"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-green-500" : "bg-red-500"}`} />
            {online ? "Online" : "Offline"}
          </span>
          <Button size="sm" variant="secondary" icon="refresh" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <span className="material-symbols-outlined text-[16px] text-yellow-500">warning</span>
          <p className="text-xs text-yellow-600 dark:text-yellow-400">{error}</p>
        </div>
      )}

      {isOllama && (
        <div className="mb-5 rounded-lg border border-border bg-surface-2/40 p-3">
          <p className="mb-2 text-sm font-medium">Install a model</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Input
                label="Model"
                list="ollama-library-models"
                placeholder="llama3.2, qwen3, deepseek-r1…"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                disabled={Boolean(pull)}
              />
              <datalist id="ollama-library-models">
                {library.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="sm:w-40">
              <Input
                label="Tag"
                list="ollama-library-tags"
                placeholder="latest"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                disabled={Boolean(pull)}
              />
              <datalist id="ollama-library-tags">
                {tags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </div>
            <Button
              size="md"
              icon="download"
              onClick={startPull}
              loading={Boolean(pull) && pull.status !== "done"}
              disabled={!online || !installModel || Boolean(pull)}
              className="sm:mb-0.5"
            >
              Install
            </Button>
          </div>
          {pull && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-text-muted">
                <span className="min-w-0 truncate">
                  {pull.model} · {pull.status}
                  {pull.rate ? ` · ${pull.rate}` : ""}
                  {pull.eta ? ` · ETA ${pull.eta}` : ""}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {pull.percent}%
                  {pull.status !== "done" && (
                    <Button size="sm" variant="ghost" icon="close" onClick={cancelPull}>
                      Cancel
                    </Button>
                  )}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all duration-300"
                  style={{ width: `${Math.max(2, pull.percent)}%` }}
                />
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-text-muted">{SERVER_HINTS["ollama-local"]}</p>
        </div>
      )}

      {isLocalHost ? (
      <div className="mb-5 rounded-lg border border-border bg-surface-2/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Server process</p>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              processState?.running
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-surface-3 text-text-muted"
            }`}
          >
            {processLabel}
          </span>
        </div>

        {processState?.running && processSource !== "managed" && (
          <p className="mt-2 text-xs text-text-muted">
            {processSource === "system"
              ? "Detected as a system process — stop it from its own service/terminal."
              : "Server is reachable but no local process matched — it may run in a container or on another host."}
          </p>
        )}

        {!isOllama && (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Input
                label={providerId === "llamacpp" ? "Model (HF repo or .gguf path)" : "Model (Hugging Face id)"}
                placeholder={providerId === "llamacpp" ? "ggml-org/gemma-3-4b-it-GGUF" : "Qwen/Qwen3-8B"}
                value={effectiveModel}
                onChange={(event) => setRunModel(event.target.value)}
                disabled={Boolean(processState?.running)}
              />
            </div>
            <div className="sm:w-28">
              <Input
                label="Port"
                placeholder={String(SERVER_DEFAULTS[providerId] || "").split(":").pop() || ""}
                value={effectivePort}
                onChange={(event) => setRunPort(event.target.value.replace(/[^0-9]/g, ""))}
                disabled={Boolean(processState?.running)}
              />
            </div>
            {processSource === "managed" ? (
              <Button variant="danger" icon="stop" loading={starting} onClick={stopServer}>
                Stop
              </Button>
            ) : (
              <Button
                icon="play_arrow"
                loading={starting}
                disabled={Boolean(processState?.running) || !effectiveModel.trim()}
                onClick={startServer}
              >
                Start
              </Button>
            )}
          </div>
        )}

        {isOllama && (
          <div className="mt-2 flex items-center gap-2">
            {processSource === "managed" ? (
              <Button size="sm" variant="danger" icon="stop" loading={starting} onClick={stopServer}>
                Stop ollama serve
              </Button>
            ) : (
              <Button
                size="sm"
                icon="play_arrow"
                loading={starting}
                disabled={Boolean(processState?.running)}
                onClick={startServer}
              >
                Start ollama serve
              </Button>
            )}
          </div>
        )}

        {processState?.command ? (
          <div className="mt-2 flex items-center gap-2">
            <p className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-muted">{processState.command}</p>
            <Button size="sm" variant="ghost" icon="content_copy" onClick={() => copy(processState.command)}>
              Copy
            </Button>
          </div>
        ) : null}
        {processState?.running && processState?.startedAt ? (
          <p className="mt-1 text-xs text-text-muted">
            up {formatDuration((Date.now() - new Date(processState.startedAt).getTime()) / 1000)}
          </p>
        ) : null}

        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="secondary" icon="article" onClick={() => setShowLogs((value) => !value)}>
            {showLogs ? "Hide logs" : "Logs"}
          </Button>
          {showLogs ? (
            <>
              <Button size="sm" variant="ghost" icon="refresh" onClick={refreshLogs}>
                Refresh
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="delete"
                onClick={async () => {
                  await fetch(`/api/local/server/logs?provider=${encodeURIComponent(providerId)}`, {
                    method: "DELETE",
                  });
                  setLogs("");
                }}
              >
                Clear
              </Button>
            </>
          ) : null}
          {lastUpdated ? (
            <span className="ml-auto text-[10px] text-text-muted">
              updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          ) : null}
        </div>

        {showLogs ? (
          <pre
            ref={logsRef}
            className="mt-2 max-h-52 overflow-auto rounded-lg border border-border bg-surface-3/60 p-2 font-mono text-[10px] text-text-main"
          >
            {logs || "No logs yet."}
          </pre>
        ) : null}
      </div>
      ) : (
        <div className="mb-5 rounded-lg border border-border bg-surface-2/40 p-3 text-xs text-text-muted">
          This connection points at a remote server — start/stop and logs are available for local
          hosts only. Manage the process on the host machine.
        </div>
      )}

      {!isOllama && online && serverModel && (
        <div className="mb-5 rounded-lg border border-border bg-surface-2/40 p-3 text-sm">
          <p>
            Serving <span className="font-medium">{serverModel.id}</span>
            {status?.contextLength ? ` · ${status.contextLength.toLocaleString()} ctx` : ""}
          </p>
          <p className="mt-1 text-xs text-text-muted">{SERVER_HINTS[providerId]}</p>
        </div>
      )}

      {providerId === "vllm" && metrics && (
        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            ["Running requests", metrics.requestsRunning],
            ["Waiting requests", metrics.requestsWaiting],
            ["GPU cache", metrics.gpuCacheUsage != null ? `${(metrics.gpuCacheUsage * 100).toFixed(1)}%` : null],
            ["Prompt tokens", metrics.promptTokensTotal],
            ["Generated tokens", metrics.generationTokensTotal],
          ]
            .filter(([, value]) => value != null)
            .map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-surface-2/50 p-2">
                <p className="text-xs text-text-muted">{label}</p>
                <p className="text-sm font-semibold">
                  {typeof value === "number" ? value.toLocaleString() : value}
                </p>
              </div>
            ))}
        </div>
      )}

      {isOllama && running.length > 0 && (
        <div className="mb-5">
          <p className="mb-2 text-sm font-medium">Running now</p>
          <div className="flex flex-col divide-y divide-black/[0.03] rounded-lg border border-border dark:divide-white/[0.03]">
            {running.map((model) => (
              <div key={model.name || model.model} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{model.name || model.model}</p>
                  <p className="text-xs text-text-muted">
                    {formatBytes(model.size_vram)} VRAM · unloads {model.expires_at ? formatDate(model.expires_at) : "—"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="eject"
                  onClick={() => unloadModel(model.name || model.model)}
                  loading={busyModel === (model.name || model.model)}
                >
                  Unload
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOllama && (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Installed models</p>
            {models.length > 0 ? (
              <Input
                placeholder="Filter models…"
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                className="w-full sm:w-56"
              />
            ) : null}
          </div>
          {models.length === 0 ? (
            <p className="text-sm text-text-muted">
              {online ? "No models installed yet — install one above." : "Ollama is not reachable."}
            </p>
          ) : filteredModels.length === 0 ? (
            <p className="text-sm text-text-muted">No model matches “{modelFilter}”.</p>
          ) : (
            <div className="flex flex-col divide-y divide-black/[0.03] rounded-lg border border-border dark:divide-white/[0.03]">
              {filteredModels.map((model) => {
                const name = model.name || model.model;
                return (
                  <div key={name} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{name}</p>
                      <p className="text-xs text-text-muted">
                        {formatBytes(model.size)}
                        {model.details?.parameter_size ? ` · ${model.details.parameter_size}` : ""}
                        {model.details?.quantization_level ? ` · ${model.details.quantization_level}` : ""}
                        {model.details?.family ? ` · ${model.details.family}` : ""}
                        {model.modified_at ? ` · ${model.modified_at.slice(0, 10)}` : ""}
                        {testResult?.model === name ? ` · tested in ${testResult.ms} ms` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="content_copy"
                        onClick={() => copy(name)}
                        title="Copy model name"
                      >
                        Copy
                      </Button>
                      <Link
                        href={`/dashboard/basic-chat?model=${encodeURIComponent(`ollama-local/${name}`)}`}
                        className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-border px-3 text-xs font-semibold text-text-main transition-colors hover:bg-surface-2"
                      >
                        <span className="material-symbols-outlined text-[16px]">forum</span>
                        Chat
                      </Link>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="play_arrow"
                        onClick={() => testModel(name)}
                        loading={busyModel === name}
                      >
                        Test
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon="delete"
                        onClick={() => deleteModel(name)}
                        loading={busyModel === name}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
