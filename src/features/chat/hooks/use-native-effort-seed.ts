import { useEffect } from "react";
import { useChatStore } from "../stores/chat-store";
import { loadNativeEffort } from "../lib/native-model-pref";

export function useNativeEffortSeed(tabId: string, agentType: string): void {
  const { setNativeEffort } = useChatStore.use.actions();
  // Seed the reasoning-effort from the saved preference once per native session,
  // then re-push it whenever the session is bound (mirrors the model re-push).
  const nativeEffort = useChatStore((s) => s.sessions[tabId]?.nativeEffort);
  const nativeBound = useChatStore((s) => {
    const sess = s.sessions[tabId];
    return sess?.agentType === "atlas-agent" && !!sess.acpAgentId && !!sess.acpSessionId
      ? `${sess.acpAgentId}::${sess.acpSessionId}`
      : null;
  });
  useEffect(() => {
    if (agentType !== "atlas-agent") return;
    // Undefined = never set for this session → seed from the global pref.
    const eff = nativeEffort ?? loadNativeEffort();
    if (nativeBound || nativeEffort === undefined) setNativeEffort(tabId, eff);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, agentType, nativeBound]);
}
