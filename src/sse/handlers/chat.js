import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { formatRetryAfter } from "open-sse/services/accountFallback.js";
import {
  createRoutingTrace,
  ensureCombo,
  recordComboModel,
  recordModelSelection,
  recordPool,
  recordAccountSelected,
  recordAccountAttempt,
} from "open-sse/services/routingTrace.js";
import {
  classifyPoolError,
  resolvePoolSessionKey,
  getSessionExcludedAccountIds,
  getSessionRetryAt,
  recordAccountFailure,
  recordAccountSuccess,
  POOL_ACTIONS,
} from "open-sse/services/accountPool.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
    const trace = createRoutingTrace({ requestedModel: modelStr, comboName: modelStr, comboStrategy, adapterAdded });
    const runComboModel = async (b, m) => {
      recordComboModel(trace, m, { status: "pending" });
      const res = await handleSingleModelChat(b, m, clientRawRequest, request, apiKey, trace);
      recordComboModel(trace, m, { status: res?.ok ? "success" : `failed:${res?.status ?? "?"}` });
      return res;
    };

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return runComboModel(cleanRawReq, m);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(runComboModel, adapterAdded),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    const comboStrategy = getActiveAdapterStrategy(requiredCapabilities, settings);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    const trace = createRoutingTrace({ requestedModel: modelStr, comboName: modelStr, comboStrategy, adapterAdded, kind: "capacity" });
    const runAdapterModel = async (b, m) => {
      recordComboModel(trace, m, { status: "pending" });
      const res = await handleSingleModelChat(b, m, clientRawRequest, request, apiKey, trace);
      recordComboModel(trace, m, { status: res?.ok ? "success" : `failed:${res?.status ?? "?"}` });
      return res;
    };
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(runAdapterModel, adapterAdded),
      log,
      comboName: modelStr,
      comboStrategy
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, createRoutingTrace({ requestedModel: modelStr }));
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, trace = null) {
  const routing = trace || createRoutingTrace({ requestedModel: modelStr });
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
      ensureCombo(routing, { name: modelStr, strategy: comboStrategy, adapterAdded, kind: "combo" });
      const runComboModel = async (b, m) => {
        recordComboModel(routing, m, { status: "pending" });
        const res = await handleSingleModelChat(b, m, clientRawRequest, request, apiKey, routing);
        recordComboModel(routing, m, { status: res?.ok ? "success" : `failed:${res?.status ?? "?"}` });
        return res;
      };

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return runComboModel(cleanRawReq, m);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(runComboModel, adapterAdded),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  recordModelSelection(routing, { provider, model });
  recordPool(routing, { provider });

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Provider account pool: all active connections of this provider are tried in
  // selection order. A session-scoped cache remembers failures within the
  // current conversation so a follow-up request does not retry an account that
  // is still cooling down (the durable modelLock_* state covers the rest).
  const poolSessionKey = resolvePoolSessionKey({ provider, headers: clientRawRequest?.headers, body });
  const excludeConnectionIds = new Set(getSessionExcludedAccountIds(poolSessionKey, model));
  let lastError = null;
  let lastStatus = null;
  let lastPoolAction = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        // Every account rejected this exact model (unsupported / not in plan):
        // surface the upstream error instead of a retry-after that implies the
        // model might work later. Quota/rate-limit exhaustion still returns 503.
        if (lastPoolAction === POOL_ACTIONS.CAPABILITY && lastStatus && lastError) {
          log.warn("POOL", `[${provider}/${model}] no account supports this model (${lastStatus}) → returning upstream error`);
          return errorResponse(lastStatus, `[${provider}/${model}] ${lastError}`);
        }
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      // Every remaining account was filtered by the session pool cache: expose
      // the earliest cooldown so the client knows when the pool frees up again.
      const retryAt = getSessionRetryAt(poolSessionKey, model);
      if (retryAt && new Date(retryAt).getTime() > Date.now()) {
        const errorMsg = lastError || `[${provider}/${model}] All accounts unavailable`;
        const human = formatRetryAfter(retryAt);
        log.warn("CHAT", `[${provider}/${model}] session pool cooling down (${human})`);
        return unavailableResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, errorMsg, retryAt, human);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    if (excludeConnectionIds.size > 0 && log?.debug) {
      log.debug("POOL", `[${provider}/${model}] selected ACC:${credentials.connectionName} · skipped ${excludeConnectionIds.size} cooling account(s)`);
    }
    recordAccountSelected(routing, {
      connectionId: credentials.connectionId,
      connectionName: credentials.connectionName,
      reason: credentials.selectionReason,
    });
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      routing,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomMode: chatSettings.headroomMode || "compress",
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) {
      // Account served the request: forget session-scoped failures for it so it
      // is immediately eligible again for the rest of the conversation.
      recordAccountSuccess(poolSessionKey, credentials.connectionId, model);
      return result.response;
    }

    // Decide at the account-pool level whether this failure is worth rotating.
    // Explicit ERROR_RULES (429/quota/5xx/auth) keep their fallback semantics;
    // malformed requests stop here; model-ineligibility retires the pair.
    const poolError = classifyPoolError(result.status, result.error, credentials._connection?.backoffLevel || 0);

    if (poolError.action === POOL_ACTIONS.NON_FALLBACK) {
      recordAccountAttempt(routing, {
        connectionId: credentials.connectionId,
        name: credentials.connectionName,
        status: result.status,
        error: result.error,
        action: "non-fallback",
      });
      log.warn("POOL", `[${provider}/${model}] permanent ${result.status} on ACC:${credentials.connectionName} → not rotating`);
      return result.response;
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }
    // Model ineligible for this account: pin a long model lock so later requests
    // skip the pair without re-hitting upstream.
    if (poolError.action === POOL_ACTIONS.CAPABILITY && !resetsAtMs) {
      resetsAtMs = Date.now() + poolError.cooldownMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    // Remember the failure for this conversation regardless of the durable lock,
    // so subsequent requests in the same session skip the account immediately.
    // When upstream reports a precise quota reset, keep the account parked until
    // then (the session cache clamps to its own ceiling).
    const poolCooldownMs = resetsAtMs && resetsAtMs > Date.now()
      ? Math.max(poolError.cooldownMs, resetsAtMs - Date.now())
      : poolError.cooldownMs;
    recordAccountFailure(poolSessionKey, credentials.connectionId, {
      model,
      status: result.status,
      cooldownMs: poolCooldownMs,
      action: poolError.action,
    });
    recordAccountAttempt(routing, {
      connectionId: credentials.connectionId,
      name: credentials.connectionName,
      status: result.status,
      error: result.error,
      action: poolError.action,
      cooldownMs: poolCooldownMs,
    });

    if (shouldFallback) {
      if (poolError.action === POOL_ACTIONS.CAPABILITY) {
        log.info("POOL", `[${provider}/${model}] ACC:${credentials.connectionName} model-ineligible (${result.status}) → next account`);
      } else {
        log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      }
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastPoolAction = poolError.action;
      continue;
    }

    return result.response;
  }
}
