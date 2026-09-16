"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

function statusClass(running) {
  return running
    ? "bg-green-500/10 text-green-600 dark:text-green-400"
    : "bg-surface-3 text-text-muted";
}

export default function RemoteAgentPageClient() {
  const [data, setData] = useState(null);
  const [logs, setLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const { copy } = useCopyToClipboard();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/remote/agent", { cache: "no-store" });
      const payload = await response.json();
      setData(payload);
      setError(payload.error || "");
    } catch (err) {
      setError(String(err?.message || err));
    }
  }, []);

  useEffect(() => {
    // Initial load; refresh() awaits its fetch before updating state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  const refreshLogs = useCallback(async () => {
    try {
      const response = await fetch("/api/remote/agent/logs?lines=300", { cache: "no-store" });
      const payload = await response.json();
      setLogs(payload.logs || "");
    } catch {
      setLogs("");
    }
  }, []);

  useEffect(() => {
    if (showLogs) {
      // Initial tail; refreshLogs() awaits its fetch before updating state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refreshLogs();
      const timer = setInterval(refreshLogs, 4000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [refreshLogs, showLogs]);

  const start = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/remote/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to start");
      }
      setShowLogs(true);
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/remote/agent", { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const prepare = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/remote/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "prepare-workspace",
          repo: repo.trim() || undefined,
          branch: branch.trim() || undefined,
          name: workspaceName.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to prepare workspace");
      }
      setRepo("");
      setBranch("");
      setWorkspaceName("");
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }, [branch, refresh, repo, workspaceName]);

  const state = data?.state || {};
  const running = Boolean(state.running);
  const tunnelName = state.name || "(not started)";
  const connectHint = `Agents window → New session → Remote → Tunnels → ${tunnelName}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Remote Agent</h1>
        <p className="text-sm text-text-muted">
          Run VS Code agent sessions on this machine — with a workspace copy — while 9Router
          provides the models. Clients connect through a dev tunnel from the Agents window
          (desktop) or insiders.vscode.dev/agents (browser); sessions keep running when you
          disconnect.
        </p>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <span className="material-symbols-outlined text-[16px] text-yellow-500">warning</span>
          <p className="text-xs text-yellow-600 dark:text-yellow-400">{error}</p>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Agent host</h2>
            <p className="break-all text-sm text-text-muted">
              {state.cli ? `${state.cli} agent host` : "VS Code CLI"}
              {state.name ? ` · tunnel ${state.name}` : ""}
              {state.pid ? ` · pid ${state.pid}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(running)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-green-500" : "bg-text-muted"}`} />
              {running ? "running" : "stopped"}
            </span>
            {running ? (
              <Button size="sm" variant="danger" icon="stop" loading={busy} onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button size="sm" icon="play_arrow" loading={busy} onClick={start}>
                Start remote agent
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border bg-surface-2/40 p-3 text-sm">
          <p className="font-medium">Connect from VS Code</p>
          <p className="mt-1 text-text-muted">{connectHint}</p>
          <p className="mt-1 text-text-muted">
            Browser: <code className="text-text-main">https://insiders.vscode.dev/agents</code>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon="content_copy" onClick={() => copy(connectHint)}>
              Copy steps
            </Button>
            <Button size="sm" variant="ghost" icon="article" onClick={() => setShowLogs((value) => !value)}>
              {showLogs ? "Hide logs" : "Logs"}
            </Button>
            {showLogs ? (
              <Button size="sm" variant="ghost" icon="refresh" onClick={refreshLogs}>
                Refresh
              </Button>
            ) : null}
          </div>
          {showLogs ? (
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface-3/60 p-2 font-mono text-[10px] text-text-main">
              {logs || "No output yet — the first start asks for GitHub/Microsoft auth in this log."}
            </pre>
          ) : null}
        </div>

        {data?.endpoints?.length ? (
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium">Live endpoints</p>
            <div className="flex flex-col gap-1 text-xs text-text-muted">
              {data.endpoints.map((endpoint, index) => (
                <span key={`${endpoint.type}-${index}`}>
                  {endpoint.type} · protocol {endpoint.protocolVersion || "?"} · pid {endpoint.pid || "?"}
                  {endpoint.connectionToken ? " · token set" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Workspace copies</h2>
        <p className="text-sm text-text-muted">
          Remote sessions run against a folder on this machine. Clone a repository (or copy a
          local folder) and then pick that folder when starting a remote session.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Git repository"
              placeholder="https://github.com/owner/repo.git"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            />
          </div>
          <div className="sm:w-36">
            <Input label="Branch" placeholder="main" value={branch} onChange={(event) => setBranch(event.target.value)} />
          </div>
          <div className="sm:w-44">
            <Input
              label="Folder name"
              placeholder="my-project"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
            />
          </div>
          <Button icon="create_new_folder" loading={busy} disabled={!repo.trim() && !workspaceName.trim()} onClick={prepare}>
            Clone
          </Button>
        </div>
        {data?.workspaces?.length ? (
          <div className="mt-3 flex flex-col divide-y divide-black/[0.03] rounded-lg border border-border dark:divide-white/[0.03]">
            {data.workspaces.map((workspace) => (
              <div key={workspace.path} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{workspace.name}</p>
                  <p className="break-all text-xs text-text-muted">{workspace.path}</p>
                </div>
                <Button size="sm" variant="ghost" icon="content_copy" onClick={() => copy(workspace.path)}>
                  Copy path
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-text-muted">No workspaces prepared yet.</p>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Models for remote harnesses</h2>
        <p className="text-sm text-text-muted">
          The agent harness runs next to the workspace and reads its own model configuration.
          Point Claude Code / Codex / opencode at this 9Router instance from the CLI Tools page so
          remote sessions consume 9Router providers, combos and pools.
        </p>
        <div className="mt-3">
          <Link
            href="/dashboard/cli-tools"
            className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-border px-4 text-sm font-semibold text-text-main transition-colors hover:bg-surface-2"
          >
            <span className="material-symbols-outlined text-[18px]">terminal</span>
            Open CLI Tools
          </Link>
        </div>
      </Card>

      {data?.sessions?.length ? (
        <Card>
          <h2 className="text-lg font-semibold">Active sessions</h2>
          <div className="mt-3 flex flex-col divide-y divide-black/[0.03] rounded-lg border border-border dark:divide-white/[0.03]">
            {data.sessions.map((session, index) => (
              <div key={session?.id || index} className="px-3 py-2 text-xs">
                <p className="truncate font-medium text-text-main">{session?.title || session?.id || `session ${index + 1}`}</p>
                <p className="text-text-muted">{session?.folder || session?.cwd || ""} {session?.harness ? `· ${session.harness}` : ""}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
