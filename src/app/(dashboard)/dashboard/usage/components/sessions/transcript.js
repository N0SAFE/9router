/**
 * Plain-Markdown transcript of a session: what was asked, what answered, what
 * it cost, and how it was routed. Handy to paste into an issue or a fix prompt.
 */

import { turnDiagnostics } from "@/lib/usage/routingEvents";

function text(value, fallback = "") {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

export function buildTranscript(session, turns) {
  const summary = session?.summary || {};
  const lines = [];

  lines.push(`# ${text(summary.label) || session?.id || "session"}`);
  lines.push("");
  lines.push(`- session: \`${session?.id}\` (${session?.kind || "unknown"})`);
  lines.push(
    `- ${summary.requests ?? turns.length} exchanges · ${(summary.tokens || 0).toLocaleString()} tokens · $${(summary.costUsd || 0).toFixed(4)}`
  );
  if (session?.routing?.providers?.length) {
    lines.push(`- providers: ${session.routing.providers.map((provider) => `${provider.name} ×${provider.count}`).join(", ")}`);
  }
  if (session?.routing?.fallbacks) lines.push(`- fallbacks: ${session.routing.fallbacks}`);
  if (summary.failures) lines.push(`- failures: ${summary.failures}`);
  lines.push("");

  turns.forEach((turn, index) => {
    const when = turn.timestamp ? new Date(turn.timestamp).toLocaleString() : "";
    lines.push(
      `## ${index + 1}. ${[turn.provider, turn.model].filter(Boolean).join("/") || "unknown"}${when ? ` · ${when}` : ""}`
    );
    lines.push("");

    for (const message of turn.userMessages || []) {
      lines.push(`**user**`);
      lines.push("");
      lines.push(text(message.text, "(content hidden)"));
      lines.push("");
    }
    for (const message of turn.toolMessages || []) {
      lines.push(`**tool result**`);
      lines.push("");
      lines.push("```");
      lines.push(text(message.text, "(empty)"));
      lines.push("```");
      lines.push("");
    }

    const assistant = turn.assistant || {};
    if (assistant.thinking) {
      lines.push("**thinking**");
      lines.push("");
      lines.push(assistant.thinking);
      lines.push("");
    }
    lines.push("**assistant**");
    lines.push("");
    lines.push(text(assistant.content, `(${turn.status || "no content"})`));
    lines.push("");

    for (const call of turn.toolCalls || []) {
      const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {});
      lines.push(`- tool \`${call.name || "tool"}\`(${args})`);
      if (call.result) {
        lines.push("  ```");
        for (const row of String(call.result).split("\n").slice(0, 20)) lines.push(`  ${row}`);
        lines.push("  ```");
      }
    }

    const bits = [];
    bits.push(`in ${turn.tokens?.input ?? 0}${turn.tokens?.cached ? ` (${turn.tokens.cached} cached)` : ""}`);
    bits.push(`out ${turn.tokens?.output ?? 0}`);
    if (turn.ttft) bits.push(`ttft ${turn.ttft}ms`);
    if (turn.total) bits.push(`total ${turn.total}ms`);
    bits.push(`$${(turn.costUsd || 0).toFixed(4)}`);
    lines.push(`- metrics: ${bits.join(" · ")}`);

    const route = [];
    if (turn.routing?.combo?.name) route.push(`combo ${turn.routing.combo.name}`);
    if (turn.routing?.selected?.name) route.push(`account ${turn.routing.selected.name}`);
    if (turn.routing?.attempts?.length) route.push(`${turn.routing.attempts.length} attempt(s)`);
    if (route.length) lines.push(`- routing: ${route.join(" · ")}`);

    for (const note of turnDiagnostics(turn)) {
      lines.push(`- ${note.level}: ${note.text}`);
    }
    lines.push("");
  });

  return lines.join("\n");
}

export function transcriptFilename(session) {
  const label = text(session?.summary?.label) || session?.id || "session";
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "session"}-transcript.md`;
}
