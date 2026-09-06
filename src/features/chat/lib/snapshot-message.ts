import type { SessionMessage } from "@/types/agents";

/**
 * Map an atlas-agents `SessionMessage` (the rich Rust snapshot state returned by
 * `agents.snapshot()`) onto the wire shape `chat-store.replaceMessages` expects.
 *
 * Shared by the history sidebar (`session-sidebar.tsx`) and `openAgentSession`
 * (`open-agent-session.ts`) so the two resume/hydrate paths stay byte-identical —
 * previously each kept its own copy and they could drift.
 *
 * Carries `result` through so a resumed transcript shows each tool call's output
 * instead of an empty card (the snapshot persists it as `ToolCall.result`).
 *
 * Carries `id` and `status` for the same reason. Dropping them here meant
 * `replaceMessages` had nothing to use and re-minted both, so every tool call in
 * a reopened conversation rendered as succeeded — a failed edit and a rejected
 * command looked exactly like ones that worked (ATL-220). The `id` matters
 * beyond display: it is the key `findToolCall` matches later deltas on, so a
 * re-minted one would push a duplicate card for a tool call that is still
 * running when the resume lands.
 */
export function snapshotMessageToWire(m: SessionMessage) {
  return {
    role: m.role === "system" ? ("system" as const) : m.role,
    content: m.content,
    timestamp: m.timestamp,
    model: m.model ?? null,
    toolCalls: m.tool_calls.map((tc) => ({
      id: tc.id,
      toolName: tc.tool_name,
      kind: tc.kind ?? null,
      arguments: (tc.arguments ?? {}) as Record<string, unknown>,
      result: tc.result ?? null,
      status: tc.status,
    })),
  };
}
