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
// A third fault ran the other way (issue 317): the pick was lost before it got
// here. After a restart every tab starts on the native agent, resuming a Codex
// thread relabels it, and the relabel dropped the explicit flag — so the resume
// adopted the mode Codex reported on `session/load`, more permissive than the
// one the user chose. The relabel now restores the saved pick (as creating or
// switching a tab does), a tab with no pick of its own falls back to it here,
// and a pick that cannot be applied is reported instead of silently replaced.
//
// Restoring an explicit pick is restoring a stated intention: the preference
// is only ever written when the user picks a mode themselves (see
// `last-mode-pref.ts`), never from a mode an agent adopted on its own.

import type { SessionKey, SessionModeInfo, SessionSnapshot } from "@/types/agents";
import type { ClaudePermissionMode } from "@/types/agent";
import {
  CLAUDE_PERMISSION_MODES,
  CLAUDE_PERMISSION_MODE_LABEL,
  agentTypeFromPluginId,
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
 * The user's pick for this session, if any.
 *
 * The tab's own explicit pick comes first, and the saved per-agent pick is
 * only the fallback for a tab that has none. The saved pick is global — the
 * tab that picked last wrote it — so preferring it would let one tab's pick
 * override another's: two Codex tabs on read-only and full-access, Codex
 * restarts, and the read-only tab would come back in full-access without a
 * word, because the restore "succeeded".
 *
 * The tab's pick can be trusted because `applyModeOnResume` drops it whenever
 * it could not be honoured: after that the picker follows the agent's mode,
 * and that is not something the user chose.
 */
function requestedMode(tabId: string): { isClaude: boolean; requested: string | undefined } {
  const session = useChatStore.getState().sessions[tabId];
  const isClaude = session?.agentType === "claude-code";
  if (!session) return { isClaude, requested: undefined };
  const pref = session.agentType ? loadLastModePref(session.agentType) : null;
  if (isClaude) {
    if (session.claudePermissionModeExplicit) {
      return { isClaude, requested: session.claudePermissionMode };
    }
    const valid = !!pref && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(pref);
    return { isClaude, requested: valid ? (pref ?? undefined) : undefined };
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
function modeName(id: string, modes: readonly SessionModeInfo[]): string {
  return (
    modes.find((m) => m.id === id)?.name ??
    CLAUDE_PERMISSION_MODE_LABEL[id as ClaudePermissionMode] ??
    id
  );
}

/**
 * Forget a saved pick this agent no longer offers.
 *
 * An agent update can rename its modes. The saved pick then names a mode that
 * does not exist any more, and keeping it would put the "could not restore"
 * bar on every resume on this agent from then on — a warning that cannot be
 * acted on becomes one people learn to ignore. Cleared, the next session
 * defers to the agent's own default, as one with no pick always has, so the
 * bar shows once. An empty list says nothing about the agent's modes (see
 * `resolveEffectiveMode`), so it clears nothing.
 *
 * A pick the agent offers but REFUSED is kept: that may be passing (a busy
 * agent), and the next resume should try it again.
 */
function forgetStalePref(agentType: string | undefined, modes: readonly SessionModeInfo[]) {
  if (!agentType || modes.length === 0) return;
  const pref = loadLastModePref(agentType);
  if (pref && !modes.some((m) => m.id === pref)) saveLastModePref(agentType, null);
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

  forgetStalePref(useChatStore.getState().sessions[tabId]?.agentType, snapshot.available_modes);

  // Say so, and keep saying it. A pick we could not apply — the agent refused it,
  // or no longer offers it — leaves the session in the agent's own mode, which
  // may well be more permissive than the one the user chose. ACP gives modes
  // no order, so Atlas cannot pick "the safer one" for them without naming
  // agents. What it can do is say so where the next prompt is typed, and keep
  // saying it until the user picks a mode (`ModeRestoreBar`). A resume that
  // does restore the pick clears a bar an earlier one left.
  const actions = useChatStore.getState().actions;
  const unrestored = requested && !honouredPick ? requested : undefined;
  actions.setUnrestoredMode(
    tabId,
    unrestored ? modeName(unrestored, snapshot.available_modes) : undefined,
  );
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
    if (!storeShowsIt && mode && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
      actions.hydrateClaudePermissionMode(tabId, mode as ClaudePermissionMode);
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
  // The picker now shows the AGENT's mode. Left marked explicit, the next
  // resume would restore that as the user's pick, and say nothing. Dropped,
  // it falls back to the saved pick, which only ever holds a mode the user
  // chose. (Claude's `hydrateClaudePermissionMode` above drops it the same way.)
  if (unrestored) actions.dropAcpModePick(tabId);
}
