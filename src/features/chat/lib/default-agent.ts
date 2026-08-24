// Which coding agent a BRAND-NEW chat starts on.
//
// The native agent, unconditionally. It is in-process, so it needs no install,
// no sign-in and no probe — it is the one agent a fresh profile is guaranteed
// to have (ADR-0002: Atlas ships no ACP agents).
//
// This used to start on Claude Code whenever a probe said it was installed and
// authenticated, falling back otherwise. Two things were wrong with that. It
// named an agent a fresh install does not have — and the agent switcher lives
// inside the composer that agent's absence disables, so the user could not
// switch away from it either. And the probe was asynchronous, which made a
// first-ever launch hold off creating the session at all until it settled.
//
// Claude Code becomes eligible the moment the user installs it, by switching to
// it like any other agent. Nothing here decides that for them.

import { NATIVE_AGENT_ID, type SwitchableAgent } from "@/types/agent";

/** The agent a new chat starts on. Synchronous and total: there is nothing to
 *  probe, so there is no "not decided yet". */
export function defaultAgentForNewSession(): SwitchableAgent {
  return NATIVE_AGENT_ID;
}
