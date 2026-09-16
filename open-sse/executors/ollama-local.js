import { DefaultExecutor } from "./default.js";
import { resolveOllamaLocalHost } from "../config/providers.js";

export class OllamaLocalExecutor extends DefaultExecutor {
  constructor() {
    super("ollama-local");
  }

  // Ollama's native /api/chat needs Ollama-shaped translation; its
  // OpenAI-compatible endpoint is a drop-in for the standard executor and
  // streams plain OpenAI SSE.
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return `${resolveOllamaLocalHost(credentials)}/v1/chat/completions`;
  }
}

export default OllamaLocalExecutor;
