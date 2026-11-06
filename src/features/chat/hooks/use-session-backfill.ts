import { useEffect } from "react";
import { agentTypeFromPluginId, type ChatSession } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import { loadCachedAcpModels } from "../lib/acp-models-cache";

export function useSessionBackfill(tabId: string, session: ChatSession | undefined): void {
  // Backfill the ACP model picker for ALREADY-bound sessions. The bind effect
  // above returns early once `acpSessionId` is set, so a session that was bound
  // before the model list existed (app update / HMR / resumed session) would
  // never get its models. When we have a binding for a non-native agent but no
  // models yet, fetch the snapshot once and seed them.
  useEffect(() => {
    const agentId = session?.acpAgentId;
    const acpSessionId = session?.acpSessionId;
    if (!agentId || !acpSessionId) return;
    // The native agent is not excluded: its models come from the seam's
    // published catalogue via this same snapshot, exactly like an external
    // agent's. The old exclusion existed because its picker was BYOK.
    if ((session?.acpAvailableModels?.length ?? 0) > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await agents.snapshotMeta({
          agent_id: agentId,
          session_id: acpSessionId,
        });
        if (cancelled) return;
        const models = snap.available_models ?? [];
        if (models.length > 0) {
          useChatStore.getState().actions.setAcpModels(tabId, snap.current_model, models);
        } else {
          // An empty snapshot means either that this agent advertises no model
          // select, or that its config options had not landed yet. Fall back to
          // the per-agent cache — same agent, so no cross-agent leak — so the
          // picker is populated either way. The cache holds the LIST only; the
          // current model comes from the session itself (`acp-models-cache`).
          // Re-read the agent type from the store — the closed-over `session`
          // is the render-time value and can be stale after the await.
          const at = useChatStore.getState().sessions[tabId]?.agentType ?? "claude-code";
          const cached = loadCachedAcpModels(at);
          if (cached && cached.availableModels.length > 0) {
            useChatStore.getState().actions.setAcpModels(tabId, null, cached.availableModels);
          }
        }
        // Same backfill for slash commands: a session bound before this
        // mount (HMR, resume, tab restore) may have missed its
        // `available_commands_update` — the snapshot carries the list.
        if (useChatStore.getState().sessions[tabId]?.availableCommands === undefined) {
          useChatStore
            .getState()
            .actions.setAcpAvailableCommands(
              tabId,
              snap.available_commands ?? [],
              agentTypeFromPluginId(snap.plugin_id),
            );
        }
        // And the knobs, for the same reasons (#32).
        if (useChatStore.getState().sessions[tabId]?.acpConfigOptions === undefined) {
          useChatStore
            .getState()
            .actions.setAcpConfigOptions(
              tabId,
              snap.config_options ?? [],
              agentTypeFromPluginId(snap.plugin_id),
            );
        }
      } catch {
        // best-effort backfill
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    tabId,
    session?.acpAgentId,
    session?.acpSessionId,
    session?.agentType,
    session?.acpAvailableModels?.length,
  ]);

  // The other-agent model prefetch is gone with `warm-acp-models`. It iterated
  // a STATIC list of five agent names to decide who to warm — the last such
  // list on the chat path (ADR-0002) — and opened a throwaway session on each
  // to harvest its model list. The persisted cache still drives the picker for
  // any agent seen before; one that has not been opened this session fills its
  // picker when it is.
}
