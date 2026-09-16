import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Curated fallback when ollama.com cannot be reached.
const FALLBACK_MODELS = [
  "llama3.2", "llama3.1", "llama3", "qwen3", "qwen3.5", "qwen2.5", "qwen2.5-coder",
  "deepseek-r1", "deepseek-v3", "gemma3", "gemma4", "phi4", "mistral", "mistral-nemo",
  "codellama", "llava", "nomic-embed-text", "mxbai-embed-large", "gpt-oss",
  "qwen3-coder", "granite3.3", "smollm2", "tinyllama", "starcoder2", "wizardcoder",
];

const LIBRARY_URL = "https://ollama.com/library";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const libraryCache = { models: [], fetchedAt: 0 };
const tagCache = new Map();

async function loadLibraryModels() {
  if (libraryCache.models.length > 0 && Date.now() - libraryCache.fetchedAt < CACHE_TTL_MS) {
    return libraryCache.models;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(LIBRARY_URL, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "9router" },
    });
    clearTimeout(timer);
    const html = await response.text();
    const names = new Set();
    const pattern = /href="\/library\/([A-Za-z0-9][A-Za-z0-9._-]*)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      names.add(match[1]);
    }
    const models = [...names].sort();
    if (models.length > 0) {
      libraryCache.models = models;
      libraryCache.fetchedAt = Date.now();
      return models;
    }
  } catch {
    // fall through to the curated list
  }
  return libraryCache.models.length > 0 ? libraryCache.models : FALLBACK_MODELS;
}

async function loadModelTags(model) {
  const cached = tagCache.get(model);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tags;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`https://ollama.com/library/${encodeURIComponent(model)}/tags`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "9router" },
    });
    clearTimeout(timer);
    const html = await response.text();
    const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`href="/library/${escaped}:([A-Za-z0-9._-]+)"`, "g");
    const tags = new Set();
    let match;
    while ((match = pattern.exec(html)) !== null) {
      tags.add(match[1]);
    }
    const list = ["latest", ...[...tags].filter((tag) => tag !== "latest").sort()];
    tagCache.set(model, { tags: list, fetchedAt: Date.now() });
    return list;
  } catch {
    return ["latest"];
  }
}

/**
 * GET /api/local/ollama/library?q=…      → models available to pull
 * GET /api/local/ollama/library?tags=…   → tags for one library model
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const tagsFor = (searchParams.get("tags") || "").trim();
  if (tagsFor) {
    return NextResponse.json({ model: tagsFor, tags: await loadModelTags(tagsFor) });
  }

  const query = (searchParams.get("q") || "").trim().toLowerCase();
  let models = await loadLibraryModels();
  if (query) {
    models = models.filter((model) => model.toLowerCase().includes(query));
  }
  return NextResponse.json(
    { models: models.slice(0, 200), total: models.length },
    { headers: { "Cache-Control": "no-store" } }
  );
}
