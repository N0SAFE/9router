export default {
  id: "llamacpp",
  priority: 56,
  hasFree: true,
  alias: "llamacpp",
  display: {
    name: "llama.cpp (local)",
    icon: "memory",
    color: "#f59e0b",
    textIcon: "LC",
    website: "https://github.com/ggml-org/llama.cpp",
    notice: {
      text: "Local llama.cpp server (llama-server) on http://localhost:8080. Models are listed live from /v1/models; load a model by starting llama-server with -m/--hf-repo.",
    },
  },
  category: "free",
  authModes: ["apikey"],
  keyOptional: true,
  transport: {
    baseUrl: "http://localhost:8080/v1/chat/completions",
    format: "openai",
  },
  serviceKinds: ["llm"],
  models: [],
  modelsFetcher: { url: "{{baseUrl}}/v1/models", type: "openai" },
  passthroughModels: true,
};
