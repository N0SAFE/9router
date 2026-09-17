/**
 * API key access policies.
 *
 * One JSON document per key describes what the key may do: allowed providers,
 * models, combos, endpoints and connections; token/cost/percentage budgets;
 * rate limits; per-request caps; feature flags; content rules; schedule and IP
 * allowlist; plus what happens when a rule is exceeded (block / downgrade /
 * warn-only dry run).
 *
 * This module is pure (no DB, no node builtins) so the dashboard editor and the
 * proxy evaluator share exactly one implementation.
 */

export const POLICY_VERSION = 1;

export const PERIODS = ["5h", "day", "week", "month", "lifetime"];
export const PERIOD_LABELS = {
  "5h": "rolling 5 hours",
  day: "per day",
  week: "per week",
  month: "per month",
  lifetime: "all time",
};

export const ENDPOINT_OPTIONS = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/api/chat",
  "/v1/embeddings",
  "/v1/images/generations",
  "/v1/audio/speech",
  "/v1/search",
  "/v1/web/fetch",
];

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MODES = ["all", "allow", "deny"];

const emptyRule = () => ({
  mode: "all",
  list: [],
});

export function defaultPolicy() {
  return {
    version: POLICY_VERSION,
    enabled: false,
    preset: "unlimited",
    dryRun: false,
    access: {
      providers: emptyRule(),
      models: { mode: "all", list: [], perProvider: {} },
      combos: emptyRule(),
      endpoints: emptyRule(),
      connections: emptyRule(),
    },
    budgets: {
      total: { tokens: null, costUsd: null, period: "month" },
      perProvider: {},
      perModel: {},
      perConnection: {},
    },
    rateLimits: { requestsPerMinute: null, requestsPerHour: null, maxConcurrent: null },
    requestCaps: { maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null, maxPromptChars: null },
    features: { streaming: true, tools: true, vision: true, reasoning: true, embeddings: true },
    content: { requiredKeywords: [], blockedKeywords: [], requireSystemPrompt: false },
    schedule: { allowedDays: [], allowedHours: null, timezone: "auto", expiresAt: null },
    network: { ipAllowlist: [] },
    onExceed: { mode: "block", downgradeTo: { models: [], providers: [] } },
  };
}

export const POLICY_PRESETS = [
  {
    id: "unlimited",
    label: "Unlimited",
    description: "No restrictions. Keeps access open while letting you add rules later.",
    build: () => ({ ...defaultPolicy(), enabled: true, preset: "unlimited" }),
  },
  {
    id: "standard",
    label: "Standard",
    description: "5M tokens and $25 per month, 120 req/min, 1200 req/hour.",
    build: () => ({
      ...defaultPolicy(),
      enabled: true,
      preset: "standard",
      budgets: { ...defaultPolicy().budgets, total: { tokens: 5_000_000, costUsd: 25, period: "month" } },
      rateLimits: { requestsPerMinute: 120, requestsPerHour: 1200, maxConcurrent: 5 },
    }),
  },
  {
    id: "team",
    label: "Team member",
    description: "2M tokens and $10 per month, 60 req/min, tools on, reasoning off.",
    build: () => ({
      ...defaultPolicy(),
      enabled: true,
      preset: "team",
      budgets: { ...defaultPolicy().budgets, total: { tokens: 2_000_000, costUsd: 10, period: "month" } },
      rateLimits: { requestsPerMinute: 60, requestsPerHour: 600, maxConcurrent: 3 },
      features: { streaming: true, tools: true, vision: true, reasoning: false, embeddings: false },
    }),
  },
  {
    id: "cheap",
    label: "Cheap models only",
    description: "Only budget model families (mini/flash/haiku/small) with a 1M tokens/$3 monthly cap.",
    build: () => {
      const policy = defaultPolicy();
      return {
        ...policy,
        enabled: true,
        preset: "cheap",
        access: {
          ...policy.access,
          models: {
            mode: "allow",
            list: [
              "gpt-5.4-mini",
              "gpt-5.4-nano",
              "gpt-5.6-luna",
              "glm-5.3-flash",
              "deepseek-v4-flash",
              "qwen3.8-flash",
              "minimax-m3",
              "mistral-small-*",
              "llama-4-maverick",
              "claude-haiku-*",
              "gemini-3.7-flash",
              "gemini-3.8-flash",
            ],
            perProvider: {},
          },
        },
        budgets: { ...policy.budgets, total: { tokens: 1_000_000, costUsd: 3, period: "month" } },
        rateLimits: { requestsPerMinute: 60, requestsPerHour: 600, maxConcurrent: 3 },
      };
    },
  },
  {
    id: "embeddings",
    label: "Embeddings only",
    description: "Only the embeddings endpoint, 2M tokens per month.",
    build: () => {
      const policy = defaultPolicy();
      return {
        ...policy,
        enabled: true,
        preset: "embeddings",
        access: { ...policy.access, endpoints: { mode: "allow", list: ["/v1/embeddings"] } },
        features: { streaming: false, tools: false, vision: false, reasoning: false, embeddings: true },
        budgets: { ...policy.budgets, total: { tokens: 2_000_000, costUsd: 5, period: "month" } },
      };
    },
  },
  {
    id: "timeboxed",
    label: "Time-boxed",
    description: "Weekdays 9:00–18:00 only, expires in 30 days, 500k tokens/day.",
    build: () => {
      const policy = defaultPolicy();
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      return {
        ...policy,
        enabled: true,
        preset: "timeboxed",
        schedule: { allowedDays: [1, 2, 3, 4, 5], allowedHours: [9, 18], timezone: "auto", expiresAt: expires },
        budgets: { ...policy.budgets, total: { tokens: 500_000, costUsd: 5, period: "day" } },
      };
    },
  },
];

const numberFmt = new Intl.NumberFormat("en-US");

function fmt(value) {
  return numberFmt.format(Math.round(Number(value) || 0));
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intOrNull(value, min, max) {
  const parsed = num(value);
  if (parsed === null) return null;
  const rounded = Math.round(parsed);
  if (min !== undefined && rounded < min) return min;
  if (max !== undefined && rounded > max) return max;
  return rounded;
}

function strList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeRule(rawRule) {
  const mode = MODES.includes(rawRule?.mode) ? rawRule.mode : "all";
  return { mode, list: strList(rawRule?.list) };
}

function normalizeBudgetRule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rule = {
    tokens: num(raw.tokens) !== null ? Math.max(0, Math.round(num(raw.tokens))) : null,
    costUsd: num(raw.costUsd) !== null ? Math.max(0, num(raw.costUsd)) : null,
    percentOfBudget: raw.percentOfBudget === null || raw.percentOfBudget === undefined ? null : intOrNull(raw.percentOfBudget, 1, 100),
    percentOfQuota: raw.percentOfQuota === null || raw.percentOfQuota === undefined ? null : intOrNull(raw.percentOfQuota, 1, 100),
    period: PERIODS.includes(raw.period) ? raw.period : "month",
  };
  const hasLimit = rule.tokens !== null || rule.costUsd !== null || rule.percentOfBudget !== null || rule.percentOfQuota !== null;
  return hasLimit ? rule : null;
}

function normalizeBudgetMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const rule = normalizeBudgetRule(value);
    if (rule && key) out[String(key)] = rule;
  }
  return out;
}

/** Deep-merge any stored/partial policy over the defaults and sanitize it. */
export function normalizePolicy(raw) {
  const base = defaultPolicy();
  if (!raw || typeof raw !== "object") return base;
  const policy = {
    version: POLICY_VERSION,
    enabled: raw.enabled === true,
    preset: typeof raw.preset === "string" ? raw.preset : "custom",
    dryRun: raw.dryRun === true,
    access: {
      providers: normalizeRule(raw.access?.providers || base.access.providers),
      models: {
        mode: MODES.includes(raw.access?.models?.mode) ? raw.access.models.mode : "all",
        list: strList(raw.access?.models?.list),
        perProvider: Object.fromEntries(
          Object.entries(raw.access?.models?.perProvider || {}).map(([provider, rule]) => [provider, normalizeRule(rule)])
        ),
      },
      combos: normalizeRule(raw.access?.combos || base.access.combos),
      endpoints: normalizeRule(raw.access?.endpoints || base.access.endpoints),
      connections: normalizeRule(raw.access?.connections || base.access.connections),
    },
    budgets: {
      total: normalizeBudgetRule(raw.budgets?.total) || { tokens: null, costUsd: null, period: "month" },
      perProvider: normalizeBudgetMap(raw.budgets?.perProvider),
      perModel: normalizeBudgetMap(raw.budgets?.perModel),
      perConnection: normalizeBudgetMap(raw.budgets?.perConnection),
    },
    rateLimits: {
      requestsPerMinute: intOrNull(raw.rateLimits?.requestsPerMinute, 1, 100000),
      requestsPerHour: intOrNull(raw.rateLimits?.requestsPerHour, 1, 1000000),
      maxConcurrent: intOrNull(raw.rateLimits?.maxConcurrent, 1, 1000),
    },
    requestCaps: {
      maxInputTokens: intOrNull(raw.requestCaps?.maxInputTokens, 1, 100_000_000),
      maxOutputTokens: intOrNull(raw.requestCaps?.maxOutputTokens, 1, 10_000_000),
      maxCostUsd: num(raw.requestCaps?.maxCostUsd) !== null ? Math.max(0, num(raw.requestCaps.maxCostUsd)) : null,
      maxPromptChars: intOrNull(raw.requestCaps?.maxPromptChars, 1, 100_000_000),
    },
    features: {
      streaming: raw.features?.streaming !== false,
      tools: raw.features?.tools !== false,
      vision: raw.features?.vision !== false,
      reasoning: raw.features?.reasoning !== false,
      embeddings: raw.features?.embeddings !== false,
    },
    content: {
      requiredKeywords: strList(raw.content?.requiredKeywords),
      blockedKeywords: strList(raw.content?.blockedKeywords),
      requireSystemPrompt: raw.content?.requireSystemPrompt === true,
    },
    schedule: {
      allowedDays: Array.isArray(raw.schedule?.allowedDays)
        ? [...new Set(raw.schedule.allowedDays.map((day) => intOrNull(day, 0, 6)).filter((day) => day !== null))]
        : [],
      allowedHours:
        Array.isArray(raw.schedule?.allowedHours) && raw.schedule.allowedHours.length === 2
          ? [intOrNull(raw.schedule.allowedHours[0], 0, 23) ?? 0, intOrNull(raw.schedule.allowedHours[1], 0, 23) ?? 23]
          : null,
      timezone: typeof raw.schedule?.timezone === "string" && raw.schedule.timezone ? raw.schedule.timezone : "auto",
      expiresAt: typeof raw.schedule?.expiresAt === "string" && raw.schedule.expiresAt ? raw.schedule.expiresAt : null,
    },
    network: { ipAllowlist: strList(raw.network?.ipAllowlist) },
    onExceed: {
      mode: ["block", "downgrade", "warn"].includes(raw.onExceed?.mode) ? raw.onExceed.mode : "block",
      downgradeTo: {
        models: strList(raw.onExceed?.downgradeTo?.models),
        providers: strList(raw.onExceed?.downgradeTo?.providers),
      },
    },
  };
  return policy;
}

// Presets return fully normalized policies so no field is ever undefined.
for (const preset of POLICY_PRESETS) {
  const build = preset.build;
  preset.build = () => normalizePolicy(build());
}

/** Validate raw input: returns { policy, errors } with human-readable errors. */
export function validatePolicy(raw) {  const policy = normalizePolicy(raw);
  const errors = [];
  if (policy.schedule.allowedHours && policy.schedule.allowedHours[0] >= policy.schedule.allowedHours[1]) {
    errors.push("Schedule hours: the end hour must be after the start hour.");
  }
  if (policy.schedule.expiresAt && Number.isNaN(new Date(policy.schedule.expiresAt).getTime())) {
    errors.push("Schedule expiry date is not a valid date.");
  }
  for (const list of [policy.content.requiredKeywords, policy.content.blockedKeywords]) {
    for (const keyword of list) {
      if (keyword.startsWith("/") && keyword.endsWith("/") && keyword.length > 1) {
        try {
          new RegExp(keyword.slice(1, -1));
        } catch {
          errors.push(`Content keyword "${keyword}" is not a valid regular expression.`);
        }
      }
    }
  }
  for (const entry of policy.network.ipAllowlist) {
    if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(entry)) {
      errors.push(`IP allowlist entry "${entry}" is not a valid IP or CIDR.`);
    }
  }
  if (policy.access.models.mode === "allow" && policy.access.models.list.length === 0) {
    errors.push("Model list is set to “only these” but the list is empty — the key could not use any model.");
  }
  if (policy.access.providers.mode === "allow" && policy.access.providers.list.length === 0) {
    errors.push("Provider list is set to “only these” but the list is empty.");
  }
  return { policy, errors };
}

/* ------------------------------- matching -------------------------------- */

/** Convert a wildcard entry (`claude-*`, `openrouter|*`) to a regex. */
function wildcardToRegex(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesRule(value, rule) {
  if (!rule || rule.mode === "all") return true;
  const list = rule.list || [];
  const hit = list.some((entry) => wildcardToRegex(entry).test(String(value ?? "")));
  return rule.mode === "allow" ? hit : !hit;
}

export function matchesModelRule(provider, model, modelsRule) {
  const full = `${provider}/${model}`;
  const perProvider = modelsRule?.perProvider?.[provider];
  if (perProvider && perProvider.mode !== "all") {
    return matchesRule(full, perProvider) || matchesRule(model, perProvider);
  }
  if (!modelsRule || modelsRule.mode === "all") return true;
  const list = modelsRule.list || [];
  const hit = list.some((entry) => {
    const pattern = entry.includes("/") ? entry : `*/${entry}`;
    if (wildcardToRegex(entry).test(full)) return true;
    if (wildcardToRegex(pattern).test(full)) return true;
    return wildcardToRegex(entry).test(model);
  });
  return modelsRule.mode === "allow" ? hit : !hit;
}

export const isProviderAllowed = (policy, provider) => matchesRule(provider, policy?.access?.providers);
export const isModelAllowed = (policy, provider, model) =>
  matchesModelRule(provider, model, policy?.access?.models);
export const isComboAllowed = (policy, combo) => matchesRule(combo, policy?.access?.combos);
export const isEndpointAllowed = (policy, endpoint) => matchesRule(endpoint, policy?.access?.endpoints);
export const isConnectionAllowed = (policy, connectionId) => matchesRule(connectionId, policy?.access?.connections);

/** Filter a list of `provider/model` strings through the access rules. */
export function filterModelsByPolicy(policy, models) {
  if (!policy?.enabled) return models;
  const providerRule = policy.access?.providers || { mode: "all", list: [] };
  return (models || []).filter((entry) => {
    if (typeof entry !== "string") return false;
    const slash = entry.indexOf("/");
    const provider = slash > 0 ? entry.slice(0, slash) : "";
    const model = slash > 0 ? entry.slice(slash + 1) : entry;
    if (provider && !matchesRule(provider, providerRule)) return false;
    if (provider && !isModelAllowed(policy, provider, model)) return false;
    return true;
  });
}

/* ------------------------------- schedule -------------------------------- */

function zonedParts(now, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone === "auto" ? undefined : timeZone,
      weekday: "short",
      hour: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const weekday = parts.find((part) => part.type === "weekday")?.value || "Mon";
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
    const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    return { dayIndex: dayIndex < 0 ? 1 : dayIndex, hour };
  } catch {
    return { dayIndex: now.getDay(), hour: now.getHours() };
  }
}

export function evaluateSchedule(policy, now = new Date()) {
  const schedule = policy?.schedule;
  if (!schedule) return [];
  const violations = [];
  if (schedule.expiresAt) {
    const expiry = new Date(schedule.expiresAt).getTime();
    if (Number.isFinite(expiry) && now.getTime() > expiry) {
      violations.push({ code: "schedule_expired", message: `This API key expired on ${schedule.expiresAt}.` });
    }
  }
  const { dayIndex, hour } = zonedParts(now, schedule.timezone || "auto");
  if (schedule.allowedDays?.length > 0 && !schedule.allowedDays.includes(dayIndex)) {
    violations.push({
      code: "schedule_day",
      message: `This API key works on ${schedule.allowedDays.map((day) => DAY_LABELS[day]).join(", ")} only (now ${DAY_LABELS[dayIndex]}).`,
    });
  }
  if (schedule.allowedHours) {
    const [start, end] = schedule.allowedHours;
    if (hour < start || hour >= end) {
      violations.push({
        code: "schedule_hours",
        message: `This API key works between ${String(start).padStart(2, "0")}:00 and ${String(end).padStart(2, "0")}:00 only (now ${String(hour).padStart(2, "0")}:00).`,
      });
    }
  }
  return violations;
}

/* -------------------------------- network -------------------------------- */

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function ipMatchesRule(ip, entry) {
  if (!ip || !entry) return false;
  if (!entry.includes("/")) return ip === entry;
  const [network, bitsRaw] = entry.split("/");
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

export function evaluateNetwork(policy, ip) {
  const allowlist = policy?.network?.ipAllowlist || [];
  if (allowlist.length === 0) return [];
  if (allowlist.some((entry) => ipMatchesRule(ip, entry))) return [];
  return [
    {
      code: "ip_not_allowed",
      message: `Requests from ${ip || "unknown IP"} are not in this API key's IP allowlist.`,
    },
  ];
}

/* -------------------------------- content -------------------------------- */

function keywordToMatcher(keyword) {
  if (keyword.startsWith("/") && keyword.endsWith("/") && keyword.length > 1) {
    try {
      return new RegExp(keyword.slice(1, -1), "i");
    } catch {
      // fall through to literal
    }
  }
  return null;
}

function keywordMatches(text, keyword) {
  const regex = keywordToMatcher(keyword);
  if (regex) return regex.test(text);
  return text.toLowerCase().includes(String(keyword).toLowerCase());
}

export function extractMessageText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const texts = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") texts.push(part);
        else if (part && typeof part === "object" && typeof part.text === "string") texts.push(part.text);
      }
    }
  }
  // Responses API / input shape
  if (typeof body?.input === "string") texts.push(body.input);
  if (typeof body?.prompt === "string") texts.push(body.prompt);
  return texts.join("\n");
}

export function evaluateContent(policy, body) {
  const content = policy?.content;
  if (!content) return [];
  const violations = [];
  const text = extractMessageText(body);
  for (const keyword of content.blockedKeywords || []) {
    if (keywordMatches(text, keyword)) {
      violations.push({ code: "content_blocked", message: `The request contains the blocked keyword “${keyword}”.` });
    }
  }
  if ((content.requiredKeywords || []).length > 0) {
    const missing = content.requiredKeywords.filter((keyword) => !keywordMatches(text, keyword));
    if (missing.length > 0) {
      violations.push({
        code: "content_required",
        message: `The request is missing required keyword(s): ${missing.join(", ")}.`,
      });
    }
  }
  if (content.requireSystemPrompt) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const hasSystem = messages.some((message) => message?.role === "system" || message?.role === "developer");
    if (!hasSystem) {
      violations.push({ code: "content_system_prompt", message: "This API key requires a system message in every request." });
    }
  }
  return violations;
}

/* -------------------------------- features ------------------------------- */

export function detectRequestFeatures(body, endpoint = "") {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const hasImages = messages.some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((part) => part && typeof part === "object" && (part.type === "image_url" || part.type === "image"))
  );
  const tools = Array.isArray(body?.tools) && body.tools.length > 0;
  const streaming = body?.stream === true;
  const reasoning = Boolean(body?.reasoning || body?.reasoning_effort || body?.thinking);
  const embeddings = String(endpoint || "").includes("/embeddings");
  return { hasImages, tools, streaming, reasoning, embeddings };
}

export function evaluateFeatures(policy, { body, endpoint }) {
  const features = policy?.features;
  if (!features) return [];
  const detected = detectRequestFeatures(body, endpoint);
  const violations = [];
  if (detected.streaming && features.streaming === false) {
    violations.push({ code: "feature_streaming", message: "Streaming is disabled for this API key." });
  }
  if ((detected.tools || (body?.functions?.length ?? 0) > 0) && features.tools === false) {
    violations.push({ code: "feature_tools", message: "Tool/function calling is disabled for this API key." });
  }
  if (detected.hasImages && features.vision === false) {
    violations.push({ code: "feature_vision", message: "Image inputs are disabled for this API key." });
  }
  if (detected.reasoning && features.reasoning === false) {
    violations.push({ code: "feature_reasoning", message: "Reasoning/thinking is disabled for this API key." });
  }
  if (detected.embeddings && features.embeddings === false) {
    violations.push({ code: "feature_embeddings", message: "The embeddings endpoint is disabled for this API key." });
  }
  return violations;
}

/* ------------------------------ request caps ------------------------------ */

/** Rough token estimate used for input caps / pre-flight checks. */
export function estimateInputTokens(body) {
  const text = extractMessageText(body);
  const toolChars = Array.isArray(body?.tools) ? JSON.stringify(body.tools).length : 0;
  return Math.round((text.length + toolChars) / 4);
}

export function evaluateRequestCaps(policy, { body, inputTokens }) {
  const caps = policy?.requestCaps;
  if (!caps) return { violations: [], clampedMaxTokens: null };
  const violations = [];
  const estimate = inputTokens ?? estimateInputTokens(body);
  if (caps.maxInputTokens !== null && estimate > caps.maxInputTokens) {
    violations.push({
      code: "cap_input_tokens",
      message: `This request is ~${fmt(estimate)} input tokens; this API key allows at most ${fmt(caps.maxInputTokens)}.`,
    });
  }
  const promptChars = extractMessageText(body).length;
  if (caps.maxPromptChars !== null && promptChars > caps.maxPromptChars) {
    violations.push({
      code: "cap_prompt_chars",
      message: `The prompt is ${fmt(promptChars)} characters; this API key allows at most ${fmt(caps.maxPromptChars)}.`,
    });
  }
  let clampedMaxTokens = null;
  if (caps.maxOutputTokens !== null) {
    const requested = num(body?.max_tokens) ?? num(body?.max_completion_tokens) ?? num(body?.max_output_tokens);
    if (requested !== null && requested > caps.maxOutputTokens) {
      clampedMaxTokens = caps.maxOutputTokens;
    }
  }
  return { violations, clampedMaxTokens };
}

/* -------------------------------- budgets -------------------------------- */

function scopeUsage(periodUsage, scope, key) {
  if (!periodUsage) return null;
  if (scope === "total") return periodUsage.total || null;
  if (scope === "provider") return periodUsage.byProvider?.[key] || null;
  if (scope === "model") return periodUsage.byModel?.[key] || null;
  if (scope === "connection") return periodUsage.byConnection?.[key] || null;
  return null;
}

function checkBudgetRule({ rule, usage, scopeLabel, violations, percentBase }) {
  const tokens = usage?.tokens || 0;
  const costUsd = usage?.costUsd || 0;

  if (rule.tokens !== null && tokens >= rule.tokens) {
    violations.push({
      code: "budget_tokens",
      scope: scopeLabel,
      message: `${scopeLabel} reached its token budget (${fmt(tokens)} / ${fmt(rule.tokens)} tokens ${PERIOD_LABELS[rule.period] || rule.period}).`,
    });
  }
  if (rule.costUsd !== null && costUsd >= rule.costUsd) {
    violations.push({
      code: "budget_cost",
      scope: scopeLabel,
      message: `${scopeLabel} reached its cost budget ($${costUsd.toFixed(2)} / $${rule.costUsd.toFixed(2)} ${PERIOD_LABELS[rule.period] || rule.period}).`,
    });
  }
  if (rule.percentOfBudget !== null) {
    const base = percentBase?.(rule.period);
    if (base && base.tokens > 0) {
      const share = (tokens / base.tokens) * 100;
      if (share >= rule.percentOfBudget) {
        violations.push({
          code: "budget_percent",
          scope: scopeLabel,
          message: `${scopeLabel} used ${share.toFixed(0)}% of this key's token budget (limit ${rule.percentOfBudget}%).`,
        });
      }
    }
  }
  if (rule.percentOfQuota !== null && usage?.quotaPercent !== null && usage?.quotaPercent !== undefined) {
    if (usage.quotaPercent >= rule.percentOfQuota) {
      violations.push({
        code: "budget_provider_quota",
        scope: scopeLabel,
        message: `${scopeLabel} consumed ~${usage.quotaPercent.toFixed(1)}% of the provider plan quota (limit ${rule.percentOfQuota}%).`,
      });
    }
  }
}

/**
 * Evaluate every budget rule.
 * @param {object} policy
 * @param {object} usage - { periods: { [period]: { total, byProvider, byModel, byConnection } },
 *                            liveQuota: { [provider]: { usedPct } },
 *                            providerTotals: { [provider]: { tokens } } }
 */
export function evaluateBudgets(policy, usage) {
  if (!policy?.enabled) return [];
  const violations = [];
  const budgets = policy.budgets || {};
  const periodOf = (rule) => rule?.period || "month";

  // total
  const totalRule = budgets.total;
  if (totalRule && (totalRule.tokens !== null || totalRule.costUsd !== null)) {
    const totalUsage = scopeUsage(usage?.periods?.[periodOf(totalRule)], "total");
    checkBudgetRule({
      rule: totalRule,
      usage: totalUsage,
      scopeLabel: "This key",
      violations,
    });
  }

  const scoped = [
    ["perProvider", "provider", "Provider"],
    ["perModel", "model", "Model"],
    ["perConnection", "connection", "Connection"],
  ];

  for (const [budgetKey, scope, label] of scoped) {
    const map = budgets[budgetKey] || {};
    for (const [key, rule] of Object.entries(map)) {
      const periodUsage = usage?.periods?.[periodOf(rule)];
      const scopedUsage = scopeUsage(periodUsage, scope, key);
      let quotaPercent = null;
      if (rule.percentOfQuota !== null && scope === "provider") {
        const live = usage?.liveQuota?.[key];
        const providerTotal = usage?.providerTotals?.[key]?.tokens ?? 0;
        const keyTokens = scopedUsage?.tokens ?? 0;
        if (live?.usedPct !== null && live?.usedPct !== undefined && providerTotal > 0) {
          quotaPercent = live.usedPct * (keyTokens / providerTotal);
        }
      }
      checkBudgetRule({
        rule,
        usage: { tokens: scopedUsage?.tokens ?? 0, costUsd: scopedUsage?.costUsd ?? 0, quotaPercent },
        scopeLabel: `${label} ${key}`,
        violations,
        percentBase: (period) => scopeUsage(usage?.periods?.[period], "total"),
      });
    }
  }

  return violations;
}

/* ------------------------------ rate limits ------------------------------- */

export function evaluateRateLimits(policy, { rpm, rph, concurrent }) {
  const limits = policy?.rateLimits;
  if (!limits) return [];
  const violations = [];
  if (limits.requestsPerMinute !== null && rpm >= limits.requestsPerMinute) {
    violations.push({
      code: "rate_rpm",
      message: `Rate limit: ${rpm} requests in the last minute (limit ${limits.requestsPerMinute}/min).`,
    });
  }
  if (limits.requestsPerHour !== null && rph >= limits.requestsPerHour) {
    violations.push({
      code: "rate_rph",
      message: `Rate limit: ${rph} requests in the last hour (limit ${limits.requestsPerHour}/hour).`,
    });
  }
  if (limits.maxConcurrent !== null && concurrent >= limits.maxConcurrent) {
    violations.push({
      code: "rate_concurrent",
      message: `Concurrency limit: ${concurrent} request(s) already in flight (limit ${limits.maxConcurrent}).`,
    });
  }
  return violations;
}

/* -------------------------------- summary -------------------------------- */

export function summarizePolicy(policy) {
  if (!policy) return ["No policy."];
  if (!policy.enabled) return ["Access is unrestricted (policy disabled)."];

  const lines = [];
  if (policy.dryRun) lines.push("Dry run: violations are logged only, requests still go through.");

  const describeRule = (label, rule, format = (v) => v) => {
    if (!rule || rule.mode === "all") return;
    const list = (rule.list || []).map(format);
    if (rule.mode === "allow") lines.push(`${label}: only ${list.join(", ") || "(nothing — blocks all)"}.`);
    else lines.push(`${label}: everything except ${list.join(", ") || "(nothing)"}.`);
  };

  describeRule("Providers", policy.access.providers, (value) => `${value}*`);
  describeRule("Models", policy.access.models, (value) => (value.includes("/") ? value : `${value}`));
  if (Object.keys(policy.access.models.perProvider || {}).length > 0) {
    const parts = Object.entries(policy.access.models.perProvider).map(
      ([provider, rule]) => `${provider} → ${rule.mode === "deny" ? "block" : "only"} ${rule.list.join(", ") || "all"}`
    );
    lines.push(`Per-provider model rules: ${parts.join(" · ")}.`);
  }
  describeRule("Combos", policy.access.combos);
  describeRule("Endpoints", policy.access.endpoints);
  describeRule("Connections", policy.access.connections);

  const describeBudget = (label, rule) => {
    if (!rule) return;
    const parts = [];
    if (rule.tokens !== null) parts.push(`${fmt(rule.tokens)} tokens`);
    if (rule.costUsd !== null) parts.push(`$${rule.costUsd}`);
    if (rule.percentOfBudget !== null && rule.percentOfBudget !== undefined) parts.push(`${rule.percentOfBudget}% of the key budget`);
    if (rule.percentOfQuota !== null && rule.percentOfQuota !== undefined) parts.push(`${rule.percentOfQuota}% of the provider quota`);
    if (parts.length > 0) lines.push(`${label}: max ${parts.join(" + ")} ${PERIOD_LABELS[rule.period] || rule.period}.`);
  };
  describeBudget("Total budget", policy.budgets.total);
  for (const [provider, rule] of Object.entries(policy.budgets.perProvider)) describeBudget(`Budget for ${provider}`, rule);
  for (const [model, rule] of Object.entries(policy.budgets.perModel)) describeBudget(`Budget for ${model}`, rule);
  for (const [connection, rule] of Object.entries(policy.budgets.perConnection)) describeBudget(`Budget for connection ${connection}`, rule);

  if (policy.rateLimits.requestsPerMinute !== null) lines.push(`Rate limit: ${policy.rateLimits.requestsPerMinute} requests/min.`);
  if (policy.rateLimits.requestsPerHour !== null) lines.push(`Rate limit: ${policy.rateLimits.requestsPerHour} requests/hour.`);
  if (policy.rateLimits.maxConcurrent !== null) lines.push(`Max ${policy.rateLimits.maxConcurrent} concurrent request(s).`);

  if (policy.requestCaps.maxInputTokens !== null) lines.push(`Max ${fmt(policy.requestCaps.maxInputTokens)} input tokens per request.`);
  if (policy.requestCaps.maxOutputTokens !== null) lines.push(`Output capped at ${fmt(policy.requestCaps.maxOutputTokens)} tokens (requests asking for more are clamped).`);
  if (policy.requestCaps.maxCostUsd !== null) lines.push(`Max $${policy.requestCaps.maxCostUsd} per request.`);
  if (policy.requestCaps.maxPromptChars !== null) lines.push(`Max ${fmt(policy.requestCaps.maxPromptChars)} prompt characters.`);

  const off = Object.entries(policy.features).filter(([, value]) => value === false).map(([key]) => key);
  if (off.length > 0) lines.push(`Disabled features: ${off.join(", ")}.`);

  if (policy.content.blockedKeywords.length > 0) lines.push(`Blocks prompts containing: ${policy.content.blockedKeywords.join(", ")}.`);
  if (policy.content.requiredKeywords.length > 0) lines.push(`Requires prompts to contain: ${policy.content.requiredKeywords.join(", ")}.`);
  if (policy.content.requireSystemPrompt) lines.push("Requires a system message in every request.");

  if (policy.schedule.allowedDays.length > 0) lines.push(`Allowed days: ${policy.schedule.allowedDays.map((day) => DAY_LABELS[day]).join(", ")}.`);
  if (policy.schedule.allowedHours) lines.push(`Allowed hours: ${String(policy.schedule.allowedHours[0]).padStart(2, "0")}:00–${String(policy.schedule.allowedHours[1]).padStart(2, "0")}:00 (${policy.schedule.timezone}).`);
  if (policy.schedule.expiresAt) lines.push(`Expires: ${new Date(policy.schedule.expiresAt).toLocaleString()}.`);
  if (policy.network.ipAllowlist.length > 0) lines.push(`IP allowlist: ${policy.network.ipAllowlist.join(", ")}.`);

  if (policy.onExceed.mode === "downgrade") {
    const targets = [...policy.onExceed.downgradeTo.models, ...policy.onExceed.downgradeTo.providers];
    lines.push(targets.length > 0 ? `When a limit is hit: downgrade to ${targets.join(" → ")}.` : "When a limit is hit: downgrade (no targets configured → blocks).");
  } else if (policy.onExceed.mode === "warn") {
    lines.push("When a limit is hit: warn only.");
  } else {
    lines.push("When a limit is hit: the request is blocked with an explanation.");
  }

  return lines;
}

/** Human description of a policy for the keys list badge. */
export function describePolicyState(policy) {
  if (!policy || !policy.enabled) return { label: "Unrestricted", tone: "neutral" };
  const lines = summarizePolicy(policy);
  const ruleCount = lines.filter((line) => !line.startsWith("When a limit")).length;
  if (policy.dryRun) return { label: `Dry run · ${ruleCount} rule${ruleCount > 1 ? "s" : ""}`, tone: "info" };
  if (ruleCount === 0) return { label: "Policy on", tone: "neutral" };
  return { label: `${ruleCount} policy rule${ruleCount > 1 ? "s" : ""}`, tone: "primary" };
}

export { MODES };
