import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chat-store";
import { canSignIn, promptSignIn } from "../lib/agent-signin";

export function useComposerAuthReason(tabId: string) {
  /** The agent's own words from the last auth failure, so a later `/login`
   *  can pass them along — the modal uses `reason` to tell "wants a provider
   *  key" from "not signed in". */
  const lastAuthReasonRef = useRef<string | null>(null);

  // An auth-classified turn failure routes to the sign-in flow (P15) instead of
  // dying as a generic banner. Every agent lands on the SAME modal now (S2):
  // Claude no longer forks to its setup dialog and Codex no longer to a pill,
  // because `AgentOAuthModal` renders whatever methods the agent advertises.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; agentType?: string; reason?: string }>)
        .detail;
      const at = detail?.agentType;
      if (!at) return;
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess?.acpSessionId || sess.acpSessionId !== detail.sessionId) return;
      lastAuthReasonRef.current = detail.reason ?? null;
      if (canSignIn(at)) promptSignIn(at, { reason: detail.reason });
    };
    window.addEventListener("atlas:auth-required", handler);
    return () => window.removeEventListener("atlas:auth-required", handler);
  }, [tabId]);

  return lastAuthReasonRef;
}
