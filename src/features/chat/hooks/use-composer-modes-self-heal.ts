import { useEffect } from "react";
import { agentTypeFromPluginId } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";

/** The composer's ACP mode picker: seeds the modes when the session-bind path
 *  missed them, and settles a pending pill whose boot hung. */
export function useComposerModesSelfHeal(tabId: string): void {
  const { setAcpModes, setAcpModesPending } = useChatStore.use.actions();
  // Show the picker as soon as the agent is non-Claude — even before its modes
  // load — so the composer can render a loading pill instead of nothing during
  // the agent spawn + new_session boot.
  const acpModesPending = useChatStore((s) => s.sessions[tabId]?.acpModesPending ?? false);
  // Self-heal the mode picker. chat-panel seeds the modes when a session is
  // first bound, but that path can be missed (resumed/restored sessions, an
  // effect that didn't re-run, etc.) — leaving a bound Codex session with the
  // modes sitting in Rust state but never pushed to the store, so no pill.
  // Since THIS component is what renders the pill, seed from here too: whenever
  // we're a bound non-Claude session with no modes loaded, pull the snapshot
  // and seed. Idempotent (bails once modes exist) and mirrors the codebase's
  // consumer-side self-heal pattern (file index / knowledge mentions).
  const seedBinding = useChatStore((s) => {
    const sess = s.sessions[tabId];
    if (!sess || sess.agentType === "claude-code") return null;
    if (!sess.acpAgentId || !sess.acpSessionId) return null;
    if ((sess.acpAvailableModes?.length ?? 0) > 0) return null;
    return `${sess.acpAgentId}::${sess.acpSessionId}`;
  });
  useEffect(() => {
    if (!seedBinding) return;
    const [agent_id, session_id] = seedBinding.split("::");
    let cancelled = false;
    void (async () => {
      try {
        const snap = await agents.snapshotMeta({ agent_id, session_id });
        if (!cancelled && snap.available_modes.length > 0) {
          setAcpModes(
            tabId,
            snap.current_mode,
            snap.available_modes,
            agentTypeFromPluginId(snap.plugin_id),
          );
        }
      } catch (err) {
        console.warn("seed ACP modes (composer self-heal) failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, seedBinding, setAcpModes]);
  // Safety net for a boot that HANGS (e.g. Codex's models-refresh waiting on a
  // child process that never answers): `new_session` neither resolves nor
  // rejects, so the create effect's `setAcpModesPending(false)` — which owns
  // settling this pill on every real outcome, success and failure alike —
  // never runs, and the picker would spin forever. This backstop must be
  // generous: a FIRST boot of a freshly installed agent legitimately takes
  // tens of seconds (adapter spawn + SDK init + the CLI's own first-run
  // setup), and a timer short enough to fire during it makes the composer
  // look ready while the agent is still starting. If the binding lands after
  // the backstop fires, the self-heal above still seeds the real modes.
  useEffect(() => {
    if (!acpModesPending) return;
    const t = setTimeout(() => setAcpModesPending(tabId, false), 120000);
    return () => clearTimeout(t);
  }, [tabId, acpModesPending, setAcpModesPending]);
}
