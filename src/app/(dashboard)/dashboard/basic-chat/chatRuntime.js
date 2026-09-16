"use client";

// Background chat runtime. The generation loop lives here (a module singleton)
// instead of inside the page component, so switching dashboard tabs or leaving
// the chat page keeps the stream running; the page simply re-subscribes when
// it comes back. State is persisted to localStorage.

const STORAGE_KEY = "basic-chat.sessions.v2";
const ACTIVE_KEY = "basic-chat.active.v2";
const PERSIST_THROTTLE_MS = 1000;

let state = {
  init: false,
  models: [],
  modelId: "",
  sessions: [],
  activeSessionId: "",
  version: 0,
};

const listeners = new Set();
const controllers = new Map();
let persistTimer = null;

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function readSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sessions));
    localStorage.setItem(ACTIVE_KEY, state.activeSessionId);
  } catch {
    // storage may be unavailable — chat still works in memory
  }
}

function persistSoon() {
  if (persistTimer) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_THROTTLE_MS);
}

function setState(patch) {
  state = { ...state, ...patch, version: state.version + 1 };
  for (const listener of listeners) {
    listener();
  }
  persistSoon();
}

function updateSession(sessionId, updater) {
  setState({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? typeof updater === "function"
          ? updater(session)
          : { ...session, ...updater }
        : session
    ),
  });
}

function updateMessage(sessionId, messageId, updater) {
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === messageId ? updater(message) : message
    ),
  }));
}

async function loadModels() {
  try {
    const response = await fetch("/api/chat/models", { cache: "no-store" });
    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : [];
    let requested = "";
    try {
      requested = new URLSearchParams(window.location.search).get("model") || "";
    } catch {
      requested = "";
    }
    const modelId =
      requested && models.some((model) => model.id === requested)
        ? requested
        : models.some((model) => model.id === state.modelId)
          ? state.modelId
          : models[0]?.id || "";
    setState({ models, modelId });
  } catch {
    setState({ models: [] });
  }
}

export const chatRuntime = {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getState() {
    return state;
  },

  init() {
    if (state.init) {
      return;
    }
    const sessions = readSessions();
    const activeSessionId = localStorage.getItem(ACTIVE_KEY) || sessions[0]?.id || "";
    setState({ init: true, sessions, activeSessionId });
    void loadModels();
  },

  setModel(modelId) {
    setState({ modelId });
  },

  newSession() {
    const session = {
      id: createId(),
      title: "New chat",
      model: state.modelId,
      createdAt: Date.now(),
      messages: [],
    };
    setState({ sessions: [session, ...state.sessions], activeSessionId: session.id });
    return session;
  },

  selectSession(sessionId) {
    setState({ activeSessionId: sessionId });
  },

  isStreaming(sessionId) {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    return Boolean(session?.messages.some((message) => message.streaming));
  },

  stop(sessionId) {
    controllers.get(sessionId)?.abort();
  },

  /** Send a message in the active session and stream the reply in background. */
  async send(text) {
    const content = String(text || "").trim();
    if (!content) {
      return;
    }
    let session = state.sessions.find((entry) => entry.id === state.activeSessionId);
    if (!session) {
      session = this.newSession();
    }
    if (this.isStreaming(session.id)) {
      return;
    }

    const modelId = state.modelId;
    const userMessage = { id: createId(), role: "user", content, ts: Date.now() };
    const assistantId = createId();
    const history = [...session.messages, userMessage];

    updateSession(session.id, {
      title: session.messages.length === 0 ? content.slice(0, 48) : session.title,
      model: modelId,
      messages: [
        ...history,
        { id: assistantId, role: "assistant", content: "", streaming: true, ts: Date.now() },
      ],
    });

    const controller = new AbortController();
    controllers.set(session.id, controller);
    let assistantText = "";
    let routing = null;

    try {
      const response = await fetch("/api/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelId,
          messages: history.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
          metadata: { clientRequestId: createId() },
        }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      const flush = () => {
        updateMessage(session.id, assistantId, (message) => ({
          ...message,
          content: assistantText,
          routing,
        }));
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) {
            continue;
          }
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (currentEvent === "9router.routing") {
            routing = parsed;
            continue;
          }
          const delta =
            parsed?.choices?.[0]?.delta?.content ??
            parsed?.choices?.[0]?.message?.content ??
            (typeof parsed?.content === "string" ? parsed.content : "");
          if (typeof delta === "string" && delta) {
            assistantText += delta;
            flush();
          }
        }
      }

      updateMessage(session.id, assistantId, (message) => ({
        ...message,
        content: assistantText,
        routing,
        streaming: false,
      }));
    } catch (err) {
      const aborted = err?.name === "AbortError";
      updateMessage(session.id, assistantId, (message) => ({
        ...message,
        content: assistantText,
        routing,
        streaming: false,
        error: aborted ? "Stopped" : String(err?.message || err),
      }));
    } finally {
      controllers.delete(session.id);
      persistNow();
    }
  },
};
