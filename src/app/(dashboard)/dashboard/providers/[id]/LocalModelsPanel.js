"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Input } from "@/shared/components";

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

/**
 * Local model manager for ollama-local / llama.cpp / vLLM:
 * - Ollama: installed models (size/date), pull-new-model combobox with live
 *   progress, delete, plus running models with VRAM usage and one-click unload.
 * - llama.cpp / vLLM: server status and the model(s) the server currently
 *   serves, with the command to load a different one.
 */
export default function LocalModelsPanel({ providerId, host = "" }) {
  const isOllama = providerId === "ollama-local";
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [library, setLibrary] = useState([]);
  const [tags, setTags] = useState(["latest"]);
  const [modelInput, setModelInput] = useState("");
  const [tagInput, setTagInput] = useState("latest");
  const [pull, setPull] = useState(null);
  const [busyModel, setBusyModel] = useState("");
  const [testResult, setTestResult] = useState(null);

  const endpointHost = host || SERVER_DEFAULTS[providerId] || "";

  const refresh = useCallback(async () => {
    try {
      const url = isOllama
        ? `/api/local/ollama/status?host=${encodeURIComponent(host)}`
        : `/api/local/server/status?provider=${encodeURIComponent(providerId)}&baseUrl=${encodeURIComponent(host)}`;
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      setStatus(data);
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
    setPull({ model: installModel, status: "starting", percent: 0 });
    try {
      const response = await fetch("/api/local/ollama/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, model: installModel }),
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
          setPull((previous) => previous
            ? { ...previous, status: event.status || previous.status, percent: percent ?? previous.percent }
            : previous);
        }
      }

      setPull({ model: installModel, status: "done", percent: 100 });
      setModelInput("");
      await refresh();
      setTimeout(() => setPull(null), 2500);
    } catch (err) {
      setPull(null);
      setError(String(err?.message || err));
    }
  }, [host, installModel, pull, refresh]);

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
              <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
                <span className="truncate">{pull.model} · {pull.status}</span>
                <span>{pull.percent}%</span>
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

      {!isOllama && online && serverModel && (
        <div className="mb-5 rounded-lg border border-border bg-surface-2/40 p-3 text-sm">
          <p>
            Serving <span className="font-medium">{serverModel.id}</span>
            {status?.contextLength ? ` · ${status.contextLength.toLocaleString()} ctx` : ""}
          </p>
          <p className="mt-1 text-xs text-text-muted">{SERVER_HINTS[providerId]}</p>
        </div>
      )}

      {!isOllama && !serverModel && online && (
        <p className="mb-5 text-sm text-text-muted">Server is running but reports no loaded model.</p>
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
          <p className="mb-2 text-sm font-medium">Installed models</p>
          {models.length === 0 ? (
            <p className="text-sm text-text-muted">
              {online ? "No models installed yet — install one above." : "Ollama is not reachable."}
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-black/[0.03] rounded-lg border border-border dark:divide-white/[0.03]">
              {models.map((model) => {
                const name = model.name || model.model;
                return (
                  <div key={name} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{name}</p>
                      <p className="text-xs text-text-muted">
                        {formatBytes(model.size)}
                        {model.details?.parameter_size ? ` · ${model.details.parameter_size}` : ""}
                        {model.modified_at ? ` · ${formatDate(model.modified_at)}` : ""}
                        {testResult?.model === name ? ` · tested in ${testResult.ms} ms` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
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
