// Which coding agent a BRAND-NEW chat starts on.
//
// Since the ACP-registry port there is exactly one answer that is always
// correct: the native in-process agent. It needs no external CLI, no download
// and no sign-in, so it is the only agent guaranteed to exist on a fresh
// install — which is precisely why Zed's picker shows only its native agent
// until the user installs something.
//
// There is deliberately no "prefer agent X if it happens to be installed"
// rule. That is what hardcoded "claude-code" was, and it turned a fresh install
// into a dead end: the composer was disabled until Claude Code was installed
// AND signed in, and the agent switcher lives inside that composer. Users pick
// their agent explicitly; new chats start somewhere that always works.

import { NATIVE_AGENT, type SwitchableAgent } from "@/types/agent";

/** The agent a new chat starts on. */
export const FALLBACK_DEFAULT_AGENT: SwitchableAgent = NATIVE_AGENT;

/** The agent a new chat should start on. Safe to call at any time — it depends
 *  on no probe, no network and no install state. */
export function defaultAgentForNewSession(): SwitchableAgent {
  return NATIVE_AGENT;
}
