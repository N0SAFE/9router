/**
 * Compact, readable digest of a stored request/response payload.
 *
 * Full bodies are truncated to `observabilityMaxJsonSize` (default 5 KB) before
 * they are stored, and the API redacts them wholesale for privacy. This module
 * builds a bounded preview instead: message roles, sizes and short text
 * snippets, tool names, and the response head/tail — enough to see what a
 * request actually contained without shipping the whole conversation.
 */

const DEFAULT_OPTS = {
  maxMessages: 30,
  previewChars: 240,
  responseChars: 500,
  maxTools: 40,
};

function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object" && typeof value.text === "string") return value.text;
  return "";
}

function preview(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function pickMessages(request) {
  if (!request || typeof request !== "object") return [];
  if (Array.isArray(request.messages)) return request.messages;
  if (Array.isArray(request.input)) {
    // Responses API: text lives in content[].text
    return request.input.map((item) => ({ ...item, role: item.role || item.type || "user" }));
  }
  return [];
}

function collectTools(request) {
  if (!request || typeof request !== "object") return [];
  const tools = Array.isArray(request.tools) ? request.tools : [];
  return tools
    .map((tool) => tool?.function?.name || tool?.name || null)
    .filter((name) => typeof name === "string" && name)
    .slice(0, DEFAULT_OPTS.maxTools);
}

/**
 * @param {object} detail - stored request detail row
 * @returns {object|null} digest or null when there is nothing to show
 */
export function buildContentDigest(detail, options = {}) {
  if (!detail || typeof detail !== "object") return null;
  const opts = { ...DEFAULT_OPTS, ...options };
  const request = detail.request && typeof detail.request === "object" ? detail.request : null;
  const response = detail.response && typeof detail.response === "object" ? detail.response : null;

  const truncated = Boolean(request?._truncated);
  const rawMessages = pickMessages(request);
  const messages = rawMessages.slice(-opts.maxMessages).map((message) => {
    const content = message?.content;
    const text = toText(content) || toText(message?.text);
    const chars = typeof content === "string" ? content.length : JSON.stringify(content || "").length;
    const toolCalls = Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((call) => call?.function?.name).filter(Boolean).slice(0, 8)
      : [];
    return {
      role: message?.role || "unknown",
      chars,
      preview: preview(text, opts.previewChars),
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  });

  const responseContent = typeof response?.content === "string" ? response.content : "";
  const responseThinking = typeof response?.thinking === "string" ? response.thinking : "";
  const hasResponse = Boolean(response && (responseContent || responseThinking || response.finish_reason));

  const digest = {
    messageCount: rawMessages.length,
    messages: messages.length ? messages : undefined,
    tools: collectTools(request),
    truncated,
    originalBytes: truncated ? request?._originalSize || null : null,
    truncatedPreview: truncated && typeof request?._preview === "string" ? preview(request._preview, opts.previewChars) : null,
    response: hasResponse
      ? {
          contentChars: responseContent.length,
          preview: preview(responseContent, opts.responseChars) || null,
          thinkingChars: responseThinking.length,
          thinkingPreview: preview(responseThinking, opts.responseChars) || null,
          finishReason: response?.finish_reason || null,
        }
      : null,
  };

  const hasAny = digest.messageCount > 0
    || (digest.tools && digest.tools.length > 0)
    || digest.response !== null
    || digest.truncated;
  return hasAny ? digest : null;
}
