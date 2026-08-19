// Per-agent work that has to happen AFTER a successful sign-in (M2 of
// `plans/atlas-acp-auth-login-loop.md`).
//
// This is the whole reason Claude used to need its own dialog. The generic flow
// ends at ACP `authenticate()`, but Claude additionally has an Atlas-side
// `claude_status` probe driving the setup screen, and that probe lags the login:
// the CLI writes credentials and exits, yet `claude auth status` can still
// report unauthenticated for a beat because the OS has not made the write
// visible to a sibling process (Keychain on macOS, fsync elsewhere). The old
// dialog handled that inline; keeping it there meant Claude could not share the
// common modal.
//
// So it becomes a hook keyed by agent type instead of a fork in the UI. Agents
// with nothing to do resolve immediately, which is all of them but Claude.

import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";

/** Retry budget for a status probe that races the credential write. Same
 *  numbers the Claude dialog used, kept together with the reason they exist. */
const POST_AUTH_PROBE_ATTEMPTS = 5;
const POST_AUTH_PROBE_DELAY_MS = 400;

/** Re-probe `claude_status` until it catches up with the credentials the login
 *  just wrote, so the setup screen does not sit on a stale "signed out". */
async function reprobeClaude(): Promise<void> {
  for (let attempt = 0; attempt < POST_AUTH_PROBE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, POST_AUTH_PROBE_DELAY_MS));
    }
    try {
      await useClaudeSetupStore.getState().actions.refreshStatus();
      if (useClaudeSetupStore.getState().phase === "ready") return;
    } catch {
      // Keep retrying — a transient probe failure is exactly the case the
      // retry budget exists for.
    }
  }
}

/** Agent types with post-sign-in work. Everything absent here is a no-op. */
const HOOKS: Record<string, () => Promise<void>> = {
  "claude-code": reprobeClaude,
};

/** Run whatever this agent needs after a successful `authenticate()`.
 *
 *  Never throws: the sign-in already succeeded by the time this runs, and
 *  failing a completed flow because a follow-up probe stumbled would be a lie to
 *  the user (and would leave them staring at an error for a session that works).
 */
export async function onAuthenticatedFor(agentType: string): Promise<void> {
  const hook = HOOKS[agentType];
  if (!hook) return;
  try {
    await hook();
  } catch {
    // Intentionally swallowed — see above.
  }
}

/** Test seam: which agent types carry a post-auth hook. */
export function agentTypesWithAuthHooks(): string[] {
  return Object.keys(HOOKS);
}
