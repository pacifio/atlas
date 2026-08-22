// Bridge from the memory corpus's agent-source strings to ACP registry ids.
//
// Two id-spaces meet in the Memory tab and they are NOT the same space:
//
//   * The **registry** identifies an agent by its plugin id — "claude-acp",
//     "codex-acp", "amp-acp". `agentMeta` treats these as opaque and remaps
//     nothing; that is a deliberate invariant of the ACP registry port and is
//     locked by `agent-meta.test.ts` ("treats an agent id as opaque").
//   * The **memory corpus** tags every doc, session and shared-memory event
//     with a bare source — "claude", "codex", "cersei" — written by
//     `agent_memory.rs` long before the registry existed, and still written
//     that way today. Session capture also stamped adapter-specific ids
//     ("claude-code-ts") before the port settled on `*-acp`.
//
// Handing a corpus source straight to `agentMeta` resolves nothing: "claude"
// matches no plugin id, so it fell through to a monogram or (worse, in the
// timeline) to a hardcoded Claude glyph for *every* unrecognised agent. That is
// how one agent could appear twice in one list under two different identities.
//
// The mapping lives here — at the boundary that owns the legacy spelling —
// rather than inside `agentMeta`, so the registry resolver stays opaque.

import { agentMeta, type AgentMeta } from "@/features/agents/lib/agent-meta";

/** Corpus/capture spelling → canonical ACP registry id. */
const SOURCE_TO_PLUGIN_ID: Record<string, string> = {
  claude: "claude-acp",
  "claude-code": "claude-acp",
  "claude-code-ts": "claude-acp",
  "claude-code-rs": "claude-acp",
  codex: "codex-acp",
};

/** Non-agent doc sources the corpus also emits. These are kinds of memory, not
 *  agents, and must never be rendered with an agent identity. */
const NON_AGENT_SOURCES = new Set(["codebase", "shared", "note", "policy", ""]);

/** Whether `source` names an agent at all (vs. a codebase/shared/note doc). */
export function isAgentSource(source: string | null | undefined): boolean {
  return typeof source === "string" && !NON_AGENT_SOURCES.has(source);
}

/** Canonical registry id for a memory-corpus source. Unknown sources pass
 *  through untouched — a registry-installed agent already tags its capture rows
 *  with its own plugin id, which is exactly what `agentMeta` wants. */
export function pluginIdForSource(source: string | null | undefined): string {
  if (typeof source !== "string" || source.length === 0) return "cersei";
  return SOURCE_TO_PLUGIN_ID[source] ?? source;
}

/** Resolved identity (label / glyph / registry icon) for a corpus source. */
export function agentMetaForSource(source: string | null | undefined): AgentMeta {
  return agentMeta(pluginIdForSource(source));
}
