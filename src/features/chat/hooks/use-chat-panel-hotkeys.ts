import { useEffect, type RefObject } from "react";
import { matchesAction } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useChatStore } from "../stores/chat-store";
import { requestModelPicker } from "../lib/model-picker-events";

/** The chat panel's own chords, gated on focus being inside `rootRef`. */
export function useChatPanelHotkeys(
  tabId: string,
  rootRef: RefObject<HTMLDivElement | null>,
): void {
  // ⌘⇧M → open (or close) this composer's model picker. Same capture-phase,
  // focus-inside-this-panel gate as the mode chord below.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!matchesAction(e, "chat.toggleModelPicker")) return;
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!root || !active || !root.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      requestModelPicker(tabId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tabId]);

  // Shift+Tab → cycle the agent permission mode. Registered on the window in
  // capture phase so the browser's default focus traversal never steals it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!matchesAction(e, "chat.cyclePermissionMode")) return;
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      // Only intercept when focus is somewhere inside this chat panel.
      if (!root || !active || !root.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      // The store action both cycles the mode AND propagates it to the bound
      // agent (so e.g. bypassPermissions actually stops permission prompts).
      // For non-Claude agents (Codex) cycle the agent-advertised ACP modes.
      const sess = useChatStore.getState().sessions[tabId];
      const actions = useChatStore.getState().actions;
      if (sess?.agentType !== "claude-code") {
        const modes = sess?.acpAvailableModes ?? [];
        if (modes.length === 0) return;
        const i = modes.findIndex((m) => m.id === sess?.acpCurrentMode);
        const next = modes[(i + 1) % modes.length];
        actions.setAcpMode(tabId, next.id);
        return;
      }
      actions.cycleClaudePermissionMode(tabId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tabId]);
  // NOTE: seeding the composer's ACP mode picker for resumed/restored sessions
  // is handled consumer-side in MessageInput (self-heal), so it can't be missed
  // by an effect that didn't re-run. The create-effect above still seeds the
  // fast path for freshly-created sessions.
}
