import type { SessionKey } from "@/types/agents";
import { pluginIdForAgent } from "@/types/agent";
import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "../stores/chat-store";
import { agents, ensureAgent } from "./agents-api";
import { projectPathForTab } from "./tab-project";
import { applyModeOnResume, holdUnrestoredMode } from "./resume-mode";
import { snapshotMessageToWire } from "./snapshot-message";

// Rebinds in flight, per tab. Restart and Send both call the rebind, and a
// queued message drains the moment the tab is bound; a second caller that
// arrives while one is running joins it instead of respawning again.
const rebindsInFlight = new Map<string, Promise<boolean>>();

/** Rebind a session whose agent process died: respawn the plugin (its spawn
 *  cache was reset on disconnect) and RESUME the same session id where the
 *  transcript kind supports it (Claude JSONL, the native engine's own) — falling
 *  back to a fresh session if the resume fails. Never runs unprompted: only
 *  the next Send or the explicit Restart affordance calls this (no silent
 *  auto-restart loops). */
export function rebindDisconnectedSession(tabId: string): Promise<boolean> {
  const running = rebindsInFlight.get(tabId);
  if (running) return running;
  const rebind = respawnAndRebind(tabId).finally(() => rebindsInFlight.delete(tabId));
  rebindsInFlight.set(tabId, rebind);
  return rebind;
}

async function respawnAndRebind(tabId: string): Promise<boolean> {
  const cs = useChatStore.getState();
  const sess = cs.sessions[tabId];
  if (!sess) return false;
  const pluginId = pluginIdForAgent(sess.agentType);
  try {
    const agent = await ensureAgent(pluginId);
    // The session's own binding first, then the TAB's project. `currentProject`
    // is the active project's — wrong for a background project's chat panel,
    // which stays mounted and can rebind while another project is in front.
    const cwd =
      sess.workingDirectory ||
      projectPathForTab(tabId) ||
      useAppStore.getState().currentProject?.path ||
      "/";
    let key: SessionKey;
    let loaded = false;
    if (sess.acpSessionId) {
      try {
        key = await agents.loadSession(agent.agent_id, sess.acpSessionId, cwd);
        loaded = true;
      } catch (err) {
        console.warn("resume after disconnect failed; starting fresh:", err);
        key = (await agents.newSession(agent.agent_id, cwd)).key;
      }
    } else {
      key = (await agents.newSession(agent.agent_id, cwd)).key;
    }
    // `session/load` replays the whole conversation, and each replayed
    // message arrives as an append — onto a tab that is still showing it, so
    // every earlier message came back a second time. Repaint from the
    // reloaded thread, as opening a history row does (`resume-session.ts`).
    // An agent that resumed without replaying hands back an empty thread;
    // then what is on screen is the record, and stays.
    if (loaded) {
      try {
        const snapshot = await agents.snapshot(key);
        if (snapshot.messages.length > 0) {
          useChatStore
            .getState()
            .actions.replaceMessages(tabId, snapshot.messages.map(snapshotMessageToWire));
        }
      } catch (err) {
        console.warn("repaint after agent restart failed:", err);
      }
    }
    // The respawned agent starts on its OWN default, and a bind does not
    // reset `acpModeExplicit`/`acpCurrentMode` — so without this the pill kept
    // showing the user's pick while the agent enforced its default. That is the
    // half of issue 289's second bug `resume-mode.ts` exists to prevent, on
    // the one resume path that was left out of it. Awaited BEFORE
    // `setAcpBinding`, as the session/new path does: binding is what flushes a
    // queued send (a tab that never bound goes from no `acpSessionId` to one),
    // so the first turn after a restart cannot run under a mode the user never
    // picked. Snapshot failure is not a rebind failure: the session exists, so
    // warn and leave the agent on its own default.
    try {
      await applyModeOnResume(tabId, key, await agents.snapshotMeta(key));
    } catch (err) {
      console.warn("mode restore after agent restart failed:", err);
      holdUnrestoredMode(tabId);
    }
    // Bind and clear the flag in the same tick, so a send the bind releases
    // never sees the tab still disconnected.
    const actions = useChatStore.getState().actions;
    actions.setAcpBinding(tabId, agent.agent_id, key.session_id, cwd);
    actions.setDisconnected(tabId, false);
    return true;
  } catch (err) {
    console.warn("agent restart failed:", err);
    return false;
  }
}
