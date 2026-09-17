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
  const [tunnel, setTunnel] = useState(null);
  const [logs, setLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [harnessInfo, setHarnessInfo] = useState(null);
  const [harnessModel, setHarnessModel] = useState("");
  const [harnessBusy, setHarnessBusy] = useState(false);
  const [harnessMessage, setHarnessMessage] = useState("");
  const { copy } = useCopyToClipboard();

  const refresh = useCallback(async () => {
    try {
      const [agentResponse, tunnelResponse] = await Promise.all([
        fetch("/api/remote/agent", { cache: "no-store" }),
        fetch("/api/remote/tunnel", { cache: "no-store" }),
      ]);
      const payload = await agentResponse.json();
      const tunnelPayload = await tunnelResponse.json();
      setData(payload);
      setTunnel(tunnelPayload.tunnel || null);
      if (typeof tunnelPayload.logs === "string") {
        setLogs(tunnelPayload.logs);
      }
      setError(payload.error || tunnelPayload.error || "");
    } catch (err) {
      setError(String(err?.message || err));
    }
  }, []);

  const refreshHarness = useCallback(async () => {
    try {
      const response = await fetch("/api/remote/harness-config", { cache: "no-store" });
      const payload = await response.json();
      setHarnessInfo(payload);
      setHarnessModel((current) => current || payload?.suggestedModels?.[0] || "");
    } catch {
      // the card simply stays empty
    }
  }, []);

  const startTunnel = useCallback(async (service = false) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/remote/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to start the tunnel");
      }
      setTunnel(payload.tunnel || null);
      setShowLogs(true);
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const stopTunnel = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/remote/tunnel", { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    // Initial load; refresh() awaits its fetch before updating state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    void refreshHarness();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh, refreshHarness]);

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

  const wireHarnesses = useCallback(async () => {
    const model = harnessModel.trim();
    if (!model) {
      return;
    }
    setHarnessBusy(true);
    setHarnessMessage("");
    try {
      const response = await fetch("/api/remote/harness-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to wire harnesses");
      }
      const results = payload.results || [];
      const failed = results.filter((item) => !item.ok);
      setHarnessMessage(
        failed.length
          ? `Wired ${results.length - failed.length}/${results.length} — failed: ${failed.map((item) => item.label).join(", ")}`
          : `Wired ${results.length} harness(es) to ${payload.baseUrl}`
      );
      await refreshHarness();
    } catch (err) {
      setHarnessMessage(String(err?.message || err));
    } finally {
      setHarnessBusy(false);
    }
  }, [harnessModel, refreshHarness]);

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
  const harnessList = harnessInfo?.harnesses || [];
  const harnessTotal = harnessList.length;
  const wiredCount = harnessList.filter((item) => item.configured).length;
  const allWired = harnessTotal > 0 && wiredCount === harnessTotal;

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
            <h2 className="text-lg font-semibold">Remote workspace tunnel (VS Code harness)</h2>
            <p className="text-sm text-text-muted">
              Connect a VS Code client to this machine as a normal remote workspace. VS Code Server
              and the extension host run here, so the built-in chat harness, tools, terminal and MCP
              servers all run on this machine — with this machine&apos;s files and models.
            </p>
            {tunnel?.url ? (
              <p className="mt-1 break-all text-xs text-text-muted">
                {tunnel.url}
                {tunnel.running ? " · running" : " · stopped"}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(Boolean(tunnel?.connected))}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${tunnel?.connected ? "bg-green-500" : tunnel?.needsAuth ? "bg-amber-500" : "bg-text-muted"}`} />
              {tunnel?.connected
                ? "connected"
                : tunnel?.needsAuth
                  ? "waiting for GitHub auth"
                  : tunnel?.running
                    ? "starting…"
                    : "off"}
            </span>
            {tunnel?.running ? (
              <Button size="sm" variant="danger" icon="stop" loading={busy} onClick={stopTunnel}>
                Stop
              </Button>
            ) : (
              <>
                <Button size="sm" icon="cloud_upload" loading={busy} onClick={() => startTunnel(false)}>
                  Start tunnel
                </Button>
                <Button size="sm" variant="secondary" icon="settings_ethernet" loading={busy} onClick={() => startTunnel(true)}>
                  Install as service
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border bg-surface-2/40 p-3 text-sm">
          <p className="font-medium">Connect and use this machine&apos;s harness</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-text-muted">
            {tunnel?.deviceCode ? (
              <li className="text-yellow-600 dark:text-yellow-400">
                Authorize this machine: open <code className="text-text-main">https://github.com/login/device</code> and
                enter code <code className="text-text-main">{tunnel.deviceCode}</code>
              </li>
            ) : null}
            <li>
              Browser: open <code className="text-text-main">{tunnel?.url || "https://vscode.dev/tunnel/<name>"}</code>.
              Desktop: install the <em>Remote - Tunnels</em> extension and run <em>Remote Tunnels: Connect to Tunnel</em>.
            </li>
            <li>Open a folder on this machine — e.g. one of the workspace copies below.</li>
            <li>
              In that remote window, install/enable the <strong>9Router Provider Bridge</strong> and run
              <em> 9Router Bridge: Add This Machine as Provider</em> (group base URL{" "}
              <code className="text-text-main">http://127.0.0.1:20128/v1</code>).
            </li>
            <li>Pick any 9Router model in the normal Chat model picker — tools, MCP and the terminal run here.</li>
          </ol>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon="content_copy" onClick={() => copy(tunnel?.url || `https://vscode.dev/tunnel/${tunnel?.name || "<name>"}`)}>
              Copy tunnel URL
            </Button>
            <Button size="sm" variant="ghost" icon="article" onClick={() => setShowLogs((value) => !value)}>
              {showLogs ? "Hide tunnel logs" : "Tunnel logs"}
            </Button>
            {showLogs ? (
              <Button size="sm" variant="ghost" icon="refresh" onClick={refresh}>
                Refresh
              </Button>
            ) : null}
          </div>
          {showLogs ? (
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface-3/60 p-2 font-mono text-[10px] text-text-main">
              {logs || "No tunnel output yet — the first start asks for GitHub/Microsoft auth here."}
            </pre>
          ) : null}
        </div>
      </Card>

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
            Handoff: <em>Continue In</em> from a local chat lands on this host — the harness runs
            here with this machine&apos;s tools/MCP and the models wired below.
          </p>
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Harnesses here → 9Router models</h2>
            <p className="text-sm text-text-muted">
              Agent handoff (<em>Continue In</em> / Agents window → this host) runs Claude Code,
              Codex or opencode on this machine. Wire their configs to this 9Router instance so
              those sessions consume 9Router providers, combos and pools. Backup files are kept
              next to each config.
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(allWired)}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${allWired ? "bg-green-500" : "bg-text-muted"}`} />
            {wiredCount}/{harnessTotal} wired
          </span>
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Model for harnesses"
              placeholder="combo name or provider/model"
              list="remote-harness-models"
              value={harnessModel}
              onChange={(event) => setHarnessModel(event.target.value)}
            />
            <datalist id="remote-harness-models">
              {(harnessInfo?.suggestedModels || []).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <Button icon="cable" loading={harnessBusy} disabled={!harnessModel.trim()} onClick={wireHarnesses}>
            Wire harnesses
          </Button>
          <Link
            href="/dashboard/cli-tools"
            className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-border px-4 text-sm font-semibold text-text-main transition-colors hover:bg-surface-2"
          >
            <span className="material-symbols-outlined text-[18px]">terminal</span>
            CLI Tools
          </Link>
        </div>
        <div className="mt-3 flex flex-col gap-1 text-xs">
          {(harnessInfo?.harnesses || []).map((item) => (
            <span
              key={item.id}
              className={item.configured ? "text-green-600 dark:text-green-400" : "text-text-muted"}
            >
              {item.configured ? "●" : "○"} {item.label} — {item.configured
                ? `${item.model || "model"} → ${item.baseUrl}`
                : "not wired to 9Router"}
            </span>
          ))}
        </div>
        {harnessMessage ? <p className="mt-2 text-xs text-text-muted">{harnessMessage}</p> : null}
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
