// Sign-in for the auto-managed built-ins (cursor / opencode / kilo).
//
// Claude and Codex each own a bespoke sign-in surface (the login dialog and the
// Codex pill). These three had none: an unauthenticated agent answered every
// prompt with a raw `Authentication required` protocol error and there was no
// way to act on it — their CLI lives in Atlas's app-data dir, not on PATH, so
// "run `cursor-agent login`" was advice the user could not follow.
//
// The flow mirrors what the adapters ask for: run the CLI's own login (opens
// the browser, streamed through `atlas:auth-run:*`), then call ACP
// `authenticate()` on the live agent so the already-running session picks the
// new credentials up without a respawn.

import { agents, ensureAgent, listenAuthRunDone } from "./agents-api";
import { isOptionalBuiltinAgent, pluginIdForAgent } from "@/types/agent";
import { agentMeta } from "@/features/agents/lib/agent-meta";

/** Resolves when the login subprocess exits. `agents.runAuthMethod` returns as
 *  soon as the process is spawned — completion arrives as an event. */
function awaitAuthRun(
  timeoutMs = 5 * 60 * 1000,
): Promise<{ success: boolean; message: string | null }> {
  return new Promise((resolve) => {
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve({
        success: false,
        message: "Timed out waiting for sign-in to finish.",
      });
    }, timeoutMs);
    void listenAuthRunDone((p) => {
      clearTimeout(timer);
      unlisten?.();
      resolve({ success: p.success, message: p.message });
    }).then((fn) => {
      unlisten = fn;
    });
  });
}

/** Run ONE advertised sign-in method end to end. Terminal-command methods run
 *  the CLI login (browser flow, streamed via `atlas:auth-run:*`) and then call
 *  ACP `authenticate()` so the live agent re-reads the fresh credentials
 *  without a respawn; command-less methods go straight to `authenticate()`
 *  (the Codex-style RPC flow). Throws with a user-facing message. */
export async function runSignInMethod(
  agentId: string,
  method: { id: string; terminalCommand?: string | null },
  label: string,
): Promise<void> {
  if (method.terminalCommand) {
    const done = awaitAuthRun();
    await agents.runAuthMethod(agentId, method.id);
    const result = await done;
    if (!result.success) {
      throw new Error(result.message ?? `Signing in to ${label} failed.`);
    }
  }
  // The adapters explicitly want this after the CLI login ("then call
  // authenticate() with methodId …"): it re-reads the credentials the login
  // just wrote, so the live session stops failing without a restart.
  await agents.authenticate(agentId, method.id);
}

/** Run the agent's browser sign-in end to end using its first advertised
 *  method. Throws with a user-facing message on any failure. */
export async function signInToAgent(agentType: string): Promise<void> {
  const label = agentMeta(agentType).label;
  const agent = await ensureAgent(pluginIdForAgent(agentType));
  const methods = await agents.listAuthMethods(agent.agent_id);
  const method = methods[0];
  if (!method) throw new Error(`${label} didn't offer a sign-in method.`);
  if (!method.terminalCommand) {
    throw new Error(
      `${label} can't be signed in from Atlas yet — its adapter offered no login command.`,
    );
  }
  await runSignInMethod(agent.agent_id, method, label);
}

/** Whether a failure means "this agent has no credentials".
 *
 *  Cursor rejects **`session/new`**, not the prompt — verified live against the
 *  CLI — so an unauthenticated agent dies at BIND time, before any turn exists.
 *  That path never emits the `atlas:auth-required` delta the turn-failure route
 *  relies on, which is why the bind catch has to recognise it on its own.
 *  Kept in sync with `atlas_acp::classify_message`'s AUTH bucket. */
export function isAuthError(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err).toLowerCase();
  return (
    m.includes("authentication") ||
    m.includes("unauthorized") ||
    m.includes("not authenticated") ||
    m.includes("auth required") ||
    m.includes("http 401") ||
    m.includes("http 403")
  );
}

/** True when `agentType` is one Atlas can drive a sign-in for. */
export function canSignIn(agentType: string | undefined): boolean {
  return !!agentType && isOptionalBuiltinAgent(agentType);
}

// ── Sign-in dialog plumbing ─────────────────────────────────────────────────
//
// `promptSignIn` used to raise an actionable toast; the built-ins now get the
// SAME modal experience Claude Code and Codex have. Lib code (bind failures,
// turn failures) can't render a dialog itself, so it dispatches this window
// event; the app-level `AgentLoginDialogHost` owns the single dialog instance.

export const AGENT_SIGNIN_EVENT = "atlas:agent-signin";

export interface AgentSignInRequest {
  agentType: string;
  requestId: number;
}

export interface SignInCallbacks {
  /** Retry whatever failed (a bind, typically) once credentials land. */
  onSignedIn?: () => void;
  /** The dialog was closed WITHOUT signing in. Callers use this to re-arm
   *  their failure reporting (NOT to retry — a retry would fail again and
   *  reopen the dialog in a loop). */
  onDismissed?: () => void;
}

let signInSeq = 0;
const signInCallbacks = new Map<number, SignInCallbacks>();

/** Retrieve-and-drop the callbacks registered for a dialog request. */
export function takeSignInCallback(requestId: number): SignInCallbacks | undefined {
  const cb = signInCallbacks.get(requestId);
  signInCallbacks.delete(requestId);
  return cb;
}

/** Open the agent sign-in dialog (same modal treatment as Claude/Codex),
 *  shared by the bind-failure and turn-failure paths so both offer the same
 *  one-click recovery. */
export function promptSignIn(
  agentType: string,
  onSignedIn?: () => void,
  onDismissed?: () => void,
): void {
  const requestId = ++signInSeq;
  if (onSignedIn || onDismissed) signInCallbacks.set(requestId, { onSignedIn, onDismissed });
  window.dispatchEvent(
    new CustomEvent<AgentSignInRequest>(AGENT_SIGNIN_EVENT, {
      detail: { agentType, requestId },
    }),
  );
}
