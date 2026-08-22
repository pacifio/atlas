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

import { agents, listenAuthRunDone } from "./agents-api";
import { catalogEntry } from "@/features/agents/lib/agent-meta";

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

/** Error classification the Rust side computed, when it sent one.
 *
 *  The session-lifecycle commands (`agents_spawn` / `agents_new_session` /
 *  `agents_load_session`) reject with a `CmdError` — `{message, kind}` — rather
 *  than a bare string, so the frontend no longer has to infer intent from
 *  English prose. Older commands (and anything thrown locally) still produce
 *  strings/Errors; both shapes are handled here.
 *
 *  Always read `.message` from this rather than stringifying the raw rejection
 *  — a structured error rendered directly is "[object Object]". */
export interface ErrInfo {
  message: string;
  /** `atlas_acp::ErrorClass` wire token, or null when unclassified. */
  kind: string | null;
}

export function errInfo(err: unknown): ErrInfo {
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; kind?: unknown };
    if (typeof o.message === "string") {
      return {
        message: o.message,
        kind: typeof o.kind === "string" ? o.kind : null,
      };
    }
  }
  return { message: String(err), kind: null };
}

/** Substring tokens that mean "no credentials".
 *
 *  MUST stay in sync with the AUTH bucket of `classify_message` in
 *  `crates/atlas-acp/src/error.rs` — this is the fallback for errors that
 *  arrive without a `kind` (legacy string rejections, provider bodies surfaced
 *  through other commands). `agent-signin.test.ts` guards the parity. */
const AUTH_TOKENS = [
  "http 401",
  "http 403",
  "authentication",
  "unauthorized",
  "invalid x-api-key",
  "invalid api key",
  "api key not",
  "permission_error",
  "no api key configured",
  "auth required",
  "not authenticated",
  "please run /login",
];

/** Whether a failure means "this agent has no credentials".
 *
 *  Cursor rejects **`session/new`**, not the prompt — verified live against the
 *  CLI — so an unauthenticated agent dies at BIND time, before any turn exists.
 *  That path never emits the `atlas:auth-required` delta the turn-failure route
 *  relies on, which is why the bind catch has to recognise it on its own.
 *
 *  Prefers the backend's own classification; falls back to substring matching. */
export function isAuthError(err: unknown): boolean {
  const info = errInfo(err);
  if (info.kind) return info.kind === "auth";
  const m = info.message.toLowerCase();
  return AUTH_TOKENS.some((t) => m.includes(t));
}

/** True when Atlas should offer its sign-in dialog for `agentType`.
 *
 *  Deliberately NOT "the catalog has a login command for it". An external
 *  agent's sign-in is only knowable at RUNTIME, from the `authMethods` it
 *  advertises in its `initialize` response — the backend can't put it in the
 *  catalog. Gating on the catalog's `login` field is what left every
 *  registry-installed agent with no way to sign in: e.g. `autohand` rejects
 *  `session/new` with "Please log in to use Autohand" while advertising a
 *  perfectly runnable `npm install -g autohand-cli` method that
 *  `runSignInMethod` can execute. The user just saw a raw protocol error.
 *
 *  So: every INSTALLED external agent gets the dialog, which lists whatever it
 *  advertises (`authKinds`) and has its own empty state when it advertises
 *  nothing. Three things are excluded, none of them by name:
 *
 *  - the native agent — BYOK keys, no sign-in at all;
 *  - an agent with no catalog entry — Atlas cannot run it, so there is nothing
 *    to sign in to. Before the catalog hydrates that is everything, which is
 *    the honest answer for the boot window: the catalog lands at startup;
 *  - a DETECTION — found on `PATH` but not installed, so the backend will
 *    refuse to spawn it (ADR-0002). Offering sign-in for an agent that cannot
 *    start is a dead end; installing it is the action that is actually
 *    available. */
export function canSignIn(agentType: string | undefined): boolean {
  if (!agentType) return false;
  const entry = catalogEntry(agentType);
  if (!entry || entry.kind === "native") return false;
  return entry.installed;
}

/** What a failed session bind should do about it. Pure, so the loop-prevention
 *  rule is testable instead of buried in a component effect. */
export type BindFailureAction =
  /** Open the sign-in dialog and rebind when it completes. */
  | "sign-in"
  /** Already signed in once and still refused — report the agent's own words. */
  | "signed-in-but-refused"
  /** Not an auth problem (or not an agent we can sign in): show the message. */
  | "report";

/** Decide how to handle a bind failure.
 *
 *  The `alreadyAttempted` guard is what stops an infinite dialog loop. The
 *  sign-in retry callback has to clear the "already reported" dedup so the
 *  rebind can report afresh — which means a rebind that fails on auth AGAIN
 *  would re-open the dialog, and completing it would retry, forever. Real
 *  agents hit this: `autohand`'s only advertised auth method is
 *  `npm install -g autohand-cli`, which installs a CLI and leaves the agent
 *  still demanding a login, so the loop would never terminate on its own. */
export function bindFailureAction(opts: {
  agentType: string | undefined;
  err: unknown;
  alreadyAttempted: boolean;
}): BindFailureAction {
  const { agentType, err, alreadyAttempted } = opts;
  if (!agentType || !canSignIn(agentType) || !isAuthError(err)) return "report";
  return alreadyAttempted ? "signed-in-but-refused" : "sign-in";
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
  /** The failure that triggered this, verbatim. The dialog inspects it to see
   *  whether the agent is asking for a provider API key it can collect in-app
   *  (see `detectKeyNeed`) rather than a login it must run. */
  reason?: string;
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
 *  one-click recovery.
 *
 *  `onSignedIn` lets the caller retry whatever failed (a bind, typically) once
 *  credentials land; `onDismissed` fires when the dialog closes WITHOUT a
 *  sign-in, so callers can re-arm failure reporting instead of retrying into a
 *  loop. `reason` should be the failure message — pass it whenever you have
 *  one, because it is what lets the dialog offer in-app key entry instead of
 *  the agent's own (often unusable) auth methods. */
export function promptSignIn(
  agentType: string,
  opts?: { onSignedIn?: () => void; onDismissed?: () => void; reason?: string },
): void {
  const requestId = ++signInSeq;
  if (opts?.onSignedIn || opts?.onDismissed) {
    signInCallbacks.set(requestId, {
      onSignedIn: opts.onSignedIn,
      onDismissed: opts.onDismissed,
    });
  }
  window.dispatchEvent(
    new CustomEvent<AgentSignInRequest>(AGENT_SIGNIN_EVENT, {
      detail: { agentType, requestId, reason: opts?.reason },
    }),
  );
}
