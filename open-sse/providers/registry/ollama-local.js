export default {
  id: "ollama-local",
  priority: 50,
  hasFree: true,
  alias: "ollama-local",
  display: {
    name: "Ollama Local",
    icon: "cloud",
    color: "#ffffffff",
    textIcon: "OL",
    website: "https://ollama.com",
    notice: {
      text: "Local Ollama server (default http://localhost:11434). Installed models are listed live from /api/tags; install/remove models from the provider page.",
    },
  },
  category: "free",
  authModes: ["apikey"],
  keyOptional: true,
  transport: {
    baseUrl: "http://localhost:11434/v1/chat/completions",
    format: "openai",
  },
  serviceKinds: ["llm"],
  models: [],
  // Live installed-model list; {{baseUrl}} expands to the connection's custom
  // host or http://localhost:11434.
  modelsFetcher: { url: "{{baseUrl}}/api/tags", type: "ollama-tags" },
  passthroughModels: true,
};
