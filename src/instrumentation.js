export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Local tools: create default connections for installed servers (best
    // effort, cached) so the dashboard always shows them.
    try {
      const { autoProvisionLocalConnections } = await import("@/lib/local/autoProvision");
      await autoProvisionLocalConnections();
    } catch {
      // best effort
    }

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Token Saver: start the 9Router-managed Headroom proxy at server boot when
    // enabled. Best-effort — inference fails open to the provider if it fails.
    try {
      const { getSettings } = await import("@/lib/localDb");
      const settings = await getSettings();
      if (settings.headroomEnabled) {
        const { startManagedHeadroomFromSettings } = await import("@/lib/headroom/process");
        const result = await startManagedHeadroomFromSettings(settings);
        if (result?.started === false && result.reason && result.reason !== "external_proxy") {
          console.log("[Headroom] auto-start skipped:", result.reason);
        }
      }
    } catch (e) {
      console.log("[Headroom] auto-start failed:", e.message);
    }
  }
}
