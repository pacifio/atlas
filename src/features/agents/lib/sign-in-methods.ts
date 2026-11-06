// The agent sign-in modal's decisions, with no UI: which phase the flow is
// in, which surface that phase belongs on, what a method's command is, which
// method a bind failure points at, and whether a method can start at all.
// `agent-oauth-modal.tsx` drives the flow; `views/agent-sign-in-view.tsx`
// draws it.

import type { AuthEnvStatus, AuthMethodWire } from "@/features/chat/lib/agents-api";
import { detectKeyNeed, envVarsForProvider } from "@/features/chat/lib/agent-key-need";
import { shellLine, type CommandTerminal } from "@/features/terminal/lib/open-command-terminal";

// The wire types, re-exported so the views can name them without importing
// the IPC wrapper module.
export type { AuthEnvStatus, AuthMethodWire };

/** One machine for all agents. */
export type SignInPhase =
  | { kind: "loading" }
  | { kind: "choose"; methods: AuthMethodWire[] }
  /** An `env_var` method: nothing to run until the shell provides the vars. */
  | { kind: "env"; method: AuthMethodWire; methods: AuthMethodWire[] }
  /** `docked`: this run has nothing for the user to read — it is a short check,
   *  not a login Atlas is driving and tailing — so it belongs in the dock
   *  rather than the dialog. See `isDocked`. */
  | { kind: "running"; label: string; docked: boolean }
  /** `manualCommand` is the escape hatch when Atlas could not drive the login
   *  itself: opencode/kilo's TUI login cannot be driven headlessly, and any CLI
   *  can fail for its own reasons. Built from the method's own resolved
   *  command, so it is correct even when the binary lives in Atlas's app-data
   *  dir rather than on the user's PATH. */
  | { kind: "error"; message: string; manualCommand?: string }
  /** The login was handed to a real terminal because it needs to be typed
   *  into. Atlas cannot see when the user finishes in there, so this phase
   *  waits for them to say so.
   *
   *  `terminal` is the handle to the one that was opened, so dismissing can
   *  take it away again — `null` only if none could be opened. */
  | {
      kind: "terminal";
      method: AuthMethodWire;
      command: string;
      terminal: CommandTerminal | null;
    }
  /** `docked` carries the surface the flow finished on, so the success frame
   *  does not swap the dialog for a pill (or back) on its way out. */
  | { kind: "done"; docked: boolean };

/**
 * Which surface this phase belongs on: `true` for the pill docked over the
 * centre panel, `false` for the dialog.
 *
 * The dialog is for the states that ask the user to DECIDE something (pick a
 * method, read a checklist, read a failure) or that have output to read. Every
 * other state — resolving what the agent even offers, a login being typed into
 * a terminal, a one-call check, the success frame — is a pill docked out of
 * the way, because a 480px dialog over the middle of the window is pure
 * interruption when there is nothing in it to act on.
 *
 * It matters most for the terminal phase: a modal dialog there is actively
 * hostile — the overlay eats the click, focus is trapped, and the first
 * attempt to reach the terminal dismisses the dialog, taking the "I've
 * finished" button with it.
 */
export function isDocked(phase: SignInPhase): boolean {
  return (
    phase.kind === "loading" ||
    phase.kind === "terminal" ||
    ((phase.kind === "running" || phase.kind === "done") && phase.docked)
  );
}

/** How an env checklist row reads a variable's state. */
export function envStatusLabel(
  v: AuthEnvStatus,
): "from shell profile" | "from environment" | "optional" | "not set" {
  if (v.satisfied) return v.source === "shell-env" ? "from shell profile" : "from environment";
  return v.optional ? "optional" : "not set";
}

/** The command that finishes this sign-in, or null when the method has no
 *  terminal spec to offer.
 *
 *  Used both for the run-it-yourself escape hatch and for the terminal
 *  hand-off, so the two cannot drift. Includes the method's environment: it
 *  carries the proxy configuration and the spawn quirks, and a login run
 *  without it reaches the network differently from the agent it signs in. */
export function manualCommandFor(method: AuthMethodWire): string | null {
  if (!method.terminalCommand) return null;
  return shellLine(method.terminalCommand, method.terminalArgs ?? [], method.terminalEnv ?? []);
}

/** Which method the agent's own complaint points at, if any.
 *
 *  When a bind fails with "GEMINI_API_KEY is missing", landing the user on a
 *  generic list of four methods makes them guess which one that maps to. If the
 *  complaint names a provider and a method is satisfied by that provider's key,
 *  open straight to its checklist.
 *
 *  This is the only consumer of `agent-key-need` left after in-app key entry
 *  was removed, and it is what keeps that table earning its place rather than
 *  being a fifth disjoint auth list.
 */
export function methodForReason(
  methods: AuthMethodWire[],
  reason: string | undefined,
): AuthMethodWire | null {
  if (!reason) return null;
  const need = detectKeyNeed(reason);
  if (!need) return null;
  // The agent often names the provider only in prose ("Gemini API key is
  // missing"), leaving `need.envVar` null — so match against every variable
  // that satisfies the provider, not just one the message happened to spell out.
  const candidates = new Set(
    [need.envVar, ...envVarsForProvider(need.provider)].filter(Boolean) as string[],
  );
  return (
    methods.find((m) => m.kind === "env_var" && m.envVars?.some((v) => candidates.has(v.name))) ??
    methods.find((m) => m.apiKeyProvider === need.provider) ??
    null
  );
}

/** Whether a method can be started at all, and if not, why.
 *
 *  This is the rule that decides whether the primary action is live, and
 *  getting it wrong either dead-ends the user on a button that does nothing or
 *  blocks a sign-in that would have worked.
 */
export function methodBlockedReason(method: AuthMethodWire, env: AuthEnvStatus[]): string | null {
  if (method.kind === "env_var") {
    const missing = env
      .filter((e) => e.methodId === method.id && !e.optional && !e.satisfied)
      .map((e) => e.name);
    if (missing.length > 0) {
      return `Set ${missing.join(", ")} in your shell profile, then reopen this.`;
    }
    return null;
  }
  // `terminal`-kind with nothing runnable is the case R3's enrichment exists to
  // prevent; if it still happens the CLI must be run by hand.
  if (method.kind === "terminal" && !method.terminalCommand) {
    return "Atlas could not find this agent's CLI to run the login.";
  }
  return null;
}
