export default {
  id: "vllm",
  priority: 57,
  hasFree: true,
  alias: "vllm",
  display: {
    name: "vLLM (local)",
    icon: "memory",
    color: "#22c55e",
    textIcon: "VL",
    website: "https://docs.vllm.ai",
    notice: {
      text: "Local vLLM server (vllm serve) on http://localhost:8000. Models are listed live from /v1/models; load a model by starting vllm serve <model>.",
    },
  },
  category: "free",
  authModes: ["apikey"],
  keyOptional: true,
  transport: {
    baseUrl: "http://localhost:8000/v1/chat/completions",
    format: "openai",
  },
  serviceKinds: ["llm"],
  models: [],
  modelsFetcher: { url: "{{baseUrl}}/v1/models", type: "openai" },
  passthroughModels: true,
};
