// Which coding agent a BRAND-NEW chat starts on.
//
// The old behaviour hard-coded "claude-code", which turned a fresh install into
// a dead end: the composer is hard-disabled until Claude Code is installed AND
// signed in, and the agent switcher lives INSIDE that composer — so a user who
// doesn't use Claude Code had no way to reach any other agent.
//
// Priority order (first match wins):
//   1. Claude Code — but only when it's actually installed + authenticated.
//   2. Atlas (the in-process native agent) — needs no external CLI, so it's
//      always a working starting point.

import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import type { SwitchableAgent } from "@/types/agent";

/** The agent used when Claude Code isn't available. */
export const FALLBACK_DEFAULT_AGENT: SwitchableAgent = "cersei";

/** Remembers the last resolved Claude readiness across launches, so a returning
 *  user whose probe hasn't landed yet still gets Claude as the default instead
 *  of racing into the fallback. Absent on a first-ever launch. */
const CLAUDE_READY_KEY = "atlas:claude-ready";

export function cachedClaudeReady(): boolean | null {
  try {
    const raw = localStorage.getItem(CLAUDE_READY_KEY);
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}

function cacheClaudeReady(ready: boolean): void {
  try {
    localStorage.setItem(CLAUDE_READY_KEY, ready ? "1" : "0");
  } catch {
    // Private mode / quota — the live probe still drives the default.
  }
}

/** True once the Claude probe has produced a real answer (installed/authed or
 *  not). "checking" is the only genuinely unknown phase; every other phase is
 *  an install/auth flow the user is actively driving, which is not "ready". */
export function claudeProbeSettled(): boolean {
  return useClaudeSetupStore.getState().phase !== "checking";
}

/**
 * The agent a new chat should start on. Safe to call at any time — while the
 * probe is still in flight it falls back to the last known answer, and
 * `useDefaultAgentType` below holds off session creation on a first-ever launch
 * until the probe settles.
 */
export function defaultAgentForNewSession(): SwitchableAgent {
  const phase = useClaudeSetupStore.getState().phase;
  if (phase !== "checking") {
    const ready = phase === "ready";
    cacheClaudeReady(ready);
    return ready ? "claude-code" : FALLBACK_DEFAULT_AGENT;
  }
  return cachedClaudeReady() ? "claude-code" : FALLBACK_DEFAULT_AGENT;
}
