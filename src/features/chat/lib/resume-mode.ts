// Re-applying the user's approval mode when a session is RESUMED.
//
// `session/new` already does this (see the bind effect in `chat-panel.tsx`):
// it reads the explicit pick the store was seeded with, validates it against
// what the agent advertises, and pushes it to the agent before the first turn
// can run. Resume did not, and the gap produced two separate faults:
//
//  1. The engine forces its own default mode on resume, so a user who chose
//     Bypass came back to Ask after a crash with nothing said about it.
//  2. One resume path seeded the mode pill from the stored preference but
//     never told the agent, so the pill could read Bypass while the engine was
//     enforcing Ask. A picker that disagrees with the engine is worse than one
//     that is merely reset, because it is not wrong in a way anyone can see.
//
// A third fault ran the other way (issue 317): after a restart every tab starts
// on the native agent, resuming a Codex thread relabels it, and the relabel
// dropped the pick, so the resume adopted the mode Codex reported on
// `session/load`, more permissive than the one the user chose. The relabel now
// restores the saved pick (`setSessionAgentType`). A pick that still cannot be
// applied fails closed: `unrestoredModeId` puts up `ModeRestoreBar` and holds
// every send until the user picks a mode.
//
// Restoring an explicit pick is restoring a stated intention: the preference
// is only ever written when the user picks a mode themselves (see
// `last-mode-pref.ts`), never from a mode an agent adopted on its own.

import type { SessionKey, SessionModeInfo, SessionSnapshot } from "@/types/agents";
import {
  CLAUDE_PERMISSION_MODE_LABEL,
  agentTypeFromPluginId,
  isClaudePermissionMode,
} from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { agents } from "./agents-api";
import { loadLastModePref, saveLastModePref } from "./last-mode-pref";

/**
 * The mode a session should actually end up in.
 *
 * `requested` is the user's explicit pick, or undefined when they never made
 * one. A pick the agent does not advertise is dropped in favour of whatever
 * the agent reports, because sending it would be rejected and would leave the
 * picker stuck on a mode id that does not exist. An agent that advertises no
 * modes at all is taken at its word and the pick is kept.
 */
export function resolveEffectiveMode(
  requested: string | undefined,
  currentMode: string | null,
  availableModes: readonly SessionModeInfo[],
): string | null {
  if (!requested) return currentMode;
  const advertised = availableModes.length === 0 || availableModes.some((m) => m.id === requested);
  return advertised ? requested : currentMode;
}

/**
 * The user's pick for this session, if any. The tab's own wins over the saved
 * per-agent pick, which is global (the tab that picked last wrote it), so
 * preferring it would let one tab's pick override another's.
 *
 * A pick an earlier resume could not apply still belongs to the tab until the
 * user answers the bar. It comes first because by then the picker shows the
 * agent's mode, and falling back to the saved pick would hand this tab
 * whatever another tab picked last.
 */
function requestedMode(tabId: string): { isClaude: boolean; requested: string | undefined } {
  const session = useChatStore.getState().sessions[tabId];
  const isClaude = session?.agentType === "claude-code";
  if (!session) return { isClaude, requested: undefined };
  if (session.unrestoredModeId) return { isClaude, requested: session.unrestoredModeId };
  const pref = session.agentType ? loadLastModePref(session.agentType) : null;
  if (isClaude) {
    if (session.claudePermissionModeExplicit) {
      return { isClaude, requested: session.claudePermissionMode };
    }
    return { isClaude, requested: isClaudePermissionMode(pref) ? pref : undefined };
  }
  return {
    isClaude,
    requested: session.acpModeExplicit
      ? (session.acpCurrentMode ?? undefined)
      : (pref ?? undefined),
  };
}

/** A mode's display name: what the agent calls it, else Atlas's own label
 *  for a Claude mode, else its id (a mode the agent no longer offers). */
export function modeName(id: string, modes: readonly SessionModeInfo[]): string {
  return (
    modes.find((m) => m.id === id)?.name ??
    (isClaudePermissionMode(id) ? CLAUDE_PERMISSION_MODE_LABEL[id] : id)
  );
}

/**
 * Forget the saved pick when it is the one this resume asked for and the agent
 * no longer offers it (an update renamed its modes). Kept, it would put the bar
 * on every resume on this agent from then on; cleared, it shows once. Only the
 * requested pick is judged: one tab's modes say nothing about a saved pick that
 * tab did not ask for. An empty list says nothing at all (see
 * `resolveEffectiveMode`). A pick the agent offers but REFUSED is kept: that
 * may be passing, and the next resume should try it again.
 */
function forgetStalePref(
  agentType: string | undefined,
  requested: string | undefined,
  modes: readonly SessionModeInfo[],
) {
  if (!agentType || !requested || modes.length === 0) return;
  if (modes.some((m) => m.id === requested)) return;
  if (loadLastModePref(agentType) === requested) saveLastModePref(agentType, null);
}

/**
 * A resume path that never got as far as `applyModeOnResume` (the snapshot
 * could not be read) left the agent in its own mode. Fail closed the same way:
 * if the user had a pick, put up the bar and hold sends until they pick again.
 */
export function holdUnrestoredMode(tabId: string): void {
  const { requested } = requestedMode(tabId);
  if (requested) useChatStore.getState().actions.setUnrestoredMode(tabId, requested);
}

/**
 * Put a resumed session into the mode the user last explicitly picked, and
 * leave the picker showing what the agent actually has.
 *
 * Call it on every resume path, in place of seeding the picker from the
 * snapshot alone.
 */
export async function applyModeOnResume(
  tabId: string,
  key: SessionKey,
  snapshot: SessionSnapshot,
): Promise<void> {
  const { isClaude, requested } = requestedMode(tabId);
  let effective = resolveEffectiveMode(requested, snapshot.current_mode, snapshot.available_modes);
  let honouredPick = !!requested && effective === requested;

  if (effective && effective !== snapshot.current_mode) {
    try {
      await agents.setMode(key, effective);
    } catch (err) {
      // The agent is the authority. If it would not take the mode, the picker
      // has to show what the agent has rather than what we wanted it to have.
      console.warn("setMode on resume failed:", err);
      effective = snapshot.current_mode;
      honouredPick = false;
    }
  }

  forgetStalePref(
    useChatStore.getState().sessions[tabId]?.agentType,
    requested,
    snapshot.available_modes,
  );

  // Fail closed. A pick we could not apply leaves the session in the agent's
  // own mode, which may be more permissive than the user's. ACP gives modes no
  // order, so Atlas cannot pick "the safer one" without naming agents; instead
  // it holds sends until the user picks (`ModeRestoreBar`). A resume that does
  // restore the pick releases them.
  const actions = useChatStore.getState().actions;
  const unrestored = requested && !honouredPick ? requested : undefined;
  actions.setUnrestoredMode(tabId, unrestored);
  if (isClaude) {
    // Seed unless the store already shows the honoured pick (restored as an
    // explicit pick by `applyPersistedModePref`): `hydrateClaudePermissionMode`
    // clears the explicit flag, which an honoured tab pick must keep.
    const mode = effective ?? snapshot.current_mode;
    const session = useChatStore.getState().sessions[tabId];
    const storeShowsIt =
      honouredPick &&
      !!session?.claudePermissionModeExplicit &&
      session.claudePermissionMode === mode;
    if (!storeShowsIt && isClaudePermissionMode(mode)) {
      actions.hydrateClaudePermissionMode(tabId, mode);
    }
    return;
  }
  // Generic ACP agents: seed from the snapshot, because the advertised list
  // travels with it and the picker needs it. This action leaves
  // `acpModeExplicit` alone, so an honoured pick stays honoured next resume.
  //
  // An empty list is not an answer about this agent's modes, it is the absence
  // of one, so seeding from it would blank a picker that was right. The
  // session/new path guards the same way.
  if (snapshot.available_modes.length > 0) {
    actions.setAcpModes(
      tabId,
      effective ?? snapshot.current_mode,
      snapshot.available_modes,
      agentTypeFromPluginId(snapshot.plugin_id),
    );
  }
  // The picker now shows the AGENT's mode, which the user never chose. (Claude's
  // `hydrateClaudePermissionMode` above drops the flag the same way.)
  if (unrestored) actions.dropAcpModePick(tabId);
}
