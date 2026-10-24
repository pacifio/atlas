// The one sign-in surface for every ACP agent (Phase M of
// `plans/atlas-acp-auth-login-loop.md`).
//
// Replaces three copy-pasted dialogs — `AgentLoginDialog` (cursor/opencode/
// kilo), `CodexLoginDialog`, and `ClaudeLoginDialog` — which had drifted into
// three different phase machines and three different renderings of the same
// idea. There is now one component, one `Phase` union, and one host; agents
// differ only in the auth methods they advertise and an optional
// `onAuthenticated` hook.
//
// Every visual here is lifted from `agent-login-dialog.tsx`, which is the
// styling reference: same Radix Dialog geometry, same header band, same
// method-row button, same type scale, same tokens. No new
// visual patterns — see the design-language rule in the plan.
//
// One method type per branch, mirroring ACP:
//   `agent`    → call `authenticate(methodId)` and let the CLI drive itself.
//   `terminal` → open the login CLI in a REAL terminal and let the user drive
//                it, with a dock offering "I've finished signing in" → a
//                best-effort `authenticate()`, then the rebind that actually
//                checks the login. Atlas no longer runs these headlessly
//                first: piped stdio cannot answer a login that asks a
//                question, so that path could only ever hang (#24).
//   `env_var`  → a read-only checklist of variables the user must export. There
//                is deliberately NO key input: for ACP agents, credentials live
//                in the system environment (the plan's BYOK-maps-to-env
//                contract), and Atlas holds no agent tokens.

import { resolveAgentSignIn } from "@/features/notifications/lib/agent-notifier";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  LogOut,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { DialogOverlay } from "@/ui/dialog";
import {
  agents,
  ensureAgent,
  listenAuthRunProgress,
  type AuthEnvStatus,
  type AuthMethodWire,
} from "@/features/chat/lib/agents-api";
import {
  AGENT_SIGNIN_EVENT,
  authenticateAfterCliLogin,
  errInfo,
  runSignInMethod,
  takeSignInCallback,
  type AgentSignInRequest,
} from "@/features/chat/lib/agent-signin";
import { detectKeyNeed, envVarsForProvider } from "@/features/chat/lib/agent-key-need";
import { copyText } from "@/lib/clipboard";
import { pluginIdForAgent } from "@/types/agent";
import { useCenterPanelCenterX } from "@/features/layout/lib/use-center-panel-x";
import { agentMeta, catalogEntry } from "@/features/agents/lib/agent-meta";
import { logEvent } from "@/features/log/lib/log";
import {
  closeCommandTerminal,
  openCommandTerminal,
  useCommandTerminalPresence,
  shellLine,
  type CommandTerminal,
} from "@/features/terminal/lib/open-command-terminal";

/** Lifted verbatim from `agent-login-dialog.tsx` — one machine for all agents. */
type Phase =
  | { kind: "loading" }
  | { kind: "choose"; methods: AuthMethodWire[] }
  /** An `env_var` method: nothing to run until the shell provides the vars. */
  | { kind: "env"; method: AuthMethodWire; methods: AuthMethodWire[] }
  /** `docked`: this run has nothing for the user to read — it is a short check,
   *  not a login Atlas is driving and tailing — so it belongs in the dock
   *  rather than the dialog. See `docked` in the component. */
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
 *  Exported for tests — this is the only consumer of `agent-key-need` left after
 *  in-app key entry was removed, and it is what keeps that table earning its
 *  place rather than being a fifth disjoint auth list.
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
 *  Exported for tests: this is the rule that decides whether the primary action
 *  is live, and getting it wrong either dead-ends the user on a button that does
 *  nothing or blocks a sign-in that would have worked.
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

export function AgentOAuthModalHost() {
  const [request, setRequest] = useState<AgentSignInRequest | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AgentSignInRequest>).detail;
      if (detail?.agentType) setRequest(detail);
    };
    window.addEventListener(AGENT_SIGNIN_EVENT, handler);
    return () => window.removeEventListener(AGENT_SIGNIN_EVENT, handler);
  }, []);

  if (!request) return null;
  return (
    <AgentOAuthModal key={request.requestId} request={request} onClose={() => setRequest(null)} />
  );
}

function AgentOAuthModal({
  request,
  onClose,
}: {
  request: AgentSignInRequest;
  onClose: () => void;
}) {
  const label = agentMeta(request.agentType).label;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [agentId, setAgentId] = useState<string | null>(null);
  const [env, setEnv] = useState<AuthEnvStatus[]>([]);
  const [nonce, setNonce] = useState(0); // "Try again" re-runs discovery
  /** Live tail of the login CLI, and the first URL it printed. */
  const [tail, setTail] = useState<string[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  /** A2: only agents that advertised `auth.logout` get a sign-out action. */
  const supportsLogout = catalogEntry(request.agentType)?.supportsLogout ?? false;

  const refreshEnv = useCallback(async (id: string) => {
    try {
      setEnv(await agents.authEnvStatus(id));
    } catch {
      // Env status is advisory — a failure here must not block sign-in.
    }
  }, []);

  /** Hand the login to a real terminal — the DEFAULT for any method that has a
   *  CLI to run.
   *
   *  The headless run pipes stdio, so a login that ASKS something — a provider
   *  picker, a device code, a y/n — can never be answered and simply hangs
   *  (#24). Atlas used to run it headlessly first and let the user discover the
   *  hang, then offer a terminal; now the terminal IS the flow.
   *
   *  Keyed on the method's OWN advertised command, never on which agent it is:
   *  whether a login is interactive is not something ACP says, so every agent
   *  that logs in through a CLI takes this path. */
  const handOffToTerminal = useCallback(
    (method: AuthMethodWire) => {
      const command = manualCommandFor(method);
      if (!command) return;
      const terminal = openCommandTerminal(command, `Sign in — ${label}`);
      setPhase({ kind: "terminal", method, command, terminal });
      logEvent({
        source: "atlas",
        kind: "agent-auth",
        summary: `${label} sign-in handed to a terminal (${method.id})`,
        status: "success",
        payload: { agent: request.agentType, method: method.id },
      });
    },
    [label, request.agentType],
  );

  /** A method Atlas should run in a terminal rather than headlessly: it has a
   *  command to run, and it is not an `env_var` checklist (which has nothing to
   *  run — the user exports the variables themselves). */
  const runsInTerminal = (m: AuthMethodWire) =>
    m.kind !== "env_var" && manualCommandFor(m) !== null;

  // On open: spawn the agent (so it advertises its auth methods) and list them.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });
    (async () => {
      try {
        const agent = await ensureAgent(pluginIdForAgent(request.agentType));
        if (cancelled) return;
        setAgentId(agent.agent_id);
        const methods = await agents.listAuthMethods(agent.agent_id);
        if (cancelled) return;
        await refreshEnv(agent.agent_id);
        if (cancelled) return;
        // Land on the method the agent's own complaint points at, when it
        // names one — otherwise the user has to map "GEMINI_API_KEY missing"
        // onto a list of four methods themselves.
        const pointed = methodForReason(methods, request.reason);
        if (pointed) {
          setPhase({ kind: "env", method: pointed, methods });
          return;
        }
        // Exactly one way in, and it is a CLI login: there is nothing to
        // choose, so skip the chooser and open the terminal. Presenting a
        // one-item list and then a hand-off is two clicks that only ever have
        // one outcome. With several methods the user still picks first.
        if (methods.length === 1 && runsInTerminal(methods[0])) {
          handOffToTerminal(methods[0]);
          return;
        }
        setPhase({ kind: "choose", methods });
      } catch (err) {
        // `agents_spawn` rejects with a structured `{message, kind}`.
        if (!cancelled) setPhase({ kind: "error", message: errInfo(err).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request.agentType, request.requestId, request.reason, nonce, refreshEnv, handOffToTerminal]);

  // The user exports a var in their shell and comes back — re-check without
  // making them reopen the modal.
  useEffect(() => {
    if (!agentId) return;
    const handler = () => void refreshEnv(agentId);
    window.addEventListener("atlas:byok-env-updated", handler);
    return () => window.removeEventListener("atlas:byok-env-updated", handler);
  }, [agentId, refreshEnv]);

  const finish = (docked: boolean) => {
    setPhase({ kind: "done", docked });
    takeSignInCallback(request.requestId)?.onSignedIn?.();
    // Closes the agent's sign-in notification episode (toast, center item).
    resolveAgentSignIn(request.agentType);
    // Brief success frame before closing, matching the dialogs this replaces.
    window.setTimeout(onClose, 700);
  };

  const run = async (method: AuthMethodWire) => {
    if (!agentId) return;
    const blocked = methodBlockedReason(method, env);
    if (blocked) {
      setPhase({ kind: "error", message: blocked, manualCommand: undefined });
      return;
    }
    // A CLI login goes straight to a terminal — see `handOffToTerminal`. Only
    // methods with nothing to type into (ACP's own `authenticate`, or an
    // `env_var` checklist the user has already satisfied) run headlessly here.
    if (runsInTerminal(method)) {
      handOffToTerminal(method);
      return;
    }
    setTail([]);
    setAuthUrl(null);
    // Atlas drives this one and tails it, so it needs the dialog's room.
    setPhase({ kind: "running", label: `Signing in to ${label}…`, docked: false });

    // Subscribe BEFORE starting, so no output is missed. Scoped by runId once
    // the run reports one — two agents signing in at once must not cross-talk.
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listenAuthRunProgress((p) => {
        if (p.agentId !== agentId) return;
        setTail((prev) => [...prev, p.line].slice(-8));
        if (p.url) setAuthUrl((u) => u ?? p.url);
      });
      await runSignInMethod(agentId, method, label);
      logEvent({
        source: "atlas",
        kind: "agent-auth",
        summary: `${label} signed in (${method.id})`,
        status: "success",
        payload: { agent: request.agentType, method: method.id },
      });
      finish(false);
    } catch (err) {
      setPhase({
        kind: "error",
        message: errInfo(err).message,
        manualCommand: manualCommandFor(method) ?? undefined,
      });
      logEvent({
        source: "atlas",
        kind: "agent-auth",
        summary: `${label} auth failed (${method.id})`,
        status: "failure",
        payload: { agent: request.agentType, method: method.id, error: String(err) },
      });
    } finally {
      unlisten?.();
    }
  };

  /** After the user says they finished in the terminal: the credentials are on
   *  disk now, so the live agent is told to re-read them — the same call the
   *  headless path makes after its login exits.
   *
   *  Not a verification, and it must not be described as one. ACP does not
   *  require an agent to fail `authenticate` when it is still signed out, nor
   *  to implement it for a terminal method at all (claude-agent-acp rejects
   *  with "Method not implemented."); adapters commonly answer `Ok` regardless.
   *  So neither its silence nor its refusal decides anything here — see
   *  `authenticateAfterCliLogin`. The rebind `finish` triggers is the check,
   *  and a second refusal reaches the user with the agent's own words. */
  const confirmTerminalSignIn = async (method: AuthMethodWire) => {
    if (!agentId) return;
    // Stays in the dock: the terminal behind it is still what the user is
    // looking at, and this is one call with nothing to show.
    setPhase({ kind: "running", label: `Checking ${label}…`, docked: true });
    await authenticateAfterCliLogin(agentId, method.id, label);
    finish(true);
  };

  /** ACP `logout` (A2) — the agent drops its own credentials; Atlas holds none
   *  to clear. Offered only when the agent advertised the capability, so this
   *  never presents an action that would 404 on the wire. */
  const signOut = async () => {
    if (!agentId) return;
    // Not docked: this starts from the chooser and returns to it, so dropping
    // to a pill and back would just make the dialog flicker.
    setPhase({ kind: "running", label: `Signing out of ${label}…`, docked: false });
    try {
      await agents.logout(agentId);
      // Back to the chooser rather than closing: signing out is nearly always
      // a prelude to signing in as someone else, and the methods are right
      // there. Re-listing picks up anything the logout changed.
      const methods = await agents.listAuthMethods(agentId);
      setPhase({ kind: "choose", methods });
      toast.success(`Signed out of ${label}.`);
      logEvent({
        source: "atlas",
        kind: "agent-auth",
        summary: `${label} signed out`,
        status: "success",
        payload: { agent: request.agentType },
      });
    } catch (err) {
      setPhase({ kind: "error", message: errInfo(err).message });
    }
  };

  const dismiss = () => {
    // Dismissing during the hand-off is a CANCELLATION, and the login CLI is
    // still alive in there, mid-prompt, with the only thing that could confirm
    // it about to disappear. Take its terminal with it. (Not done on success:
    // there the CLI has exited and its output is worth keeping.)
    if (phase.kind === "terminal" && phase.terminal) closeCommandTerminal(phase.terminal);
    // Reached on ANY close; after a successful sign-in the callbacks were
    // already taken above, so this take() is a no-op then. On a real dismissal
    // it lets the caller re-arm its failure reporting — without it one Esc
    // permanently silenced every later bind failure for the tab.
    takeSignInCallback(request.requestId)?.onDismissed?.();
    onClose();
  };

  // Which surface this phase belongs on.
  //
  // The dialog is for the states that ask the user to DECIDE something (pick a
  // method, read a checklist, read a failure) or that have output to read. Every
  // other state — resolving what the agent even offers, a login being typed into
  // a terminal, a one-call check, the success frame — is a pill docked out of
  // the way, because a 480px dialog over the middle of the window is pure
  // interruption when there is nothing in it to act on.
  //
  // It matters most for the terminal phase: a modal dialog there is actively
  // hostile — the overlay eats the click, focus is trapped, and the first
  // attempt to reach the terminal dismisses the dialog, taking the "I've
  // finished" button with it.
  const docked =
    phase.kind === "loading" ||
    phase.kind === "terminal" ||
    ((phase.kind === "running" || phase.kind === "done") && phase.docked);
  // Centred on the content, not the window: with source control or the
  // project switcher open, `left-1/2` sat the dock half a panel off-centre.
  // `left-1/2` stays as the fallback for a window with no centre panel.
  const centerX = useCenterPanelCenterX();
  const centred = centerX != null ? { left: centerX } : undefined;

  // The terminal hand-off dock belongs to ONE tab, and it is `fixed` inside a
  // portal, so nothing about its position tied it to that tab: switching to a
  // chat left it floating over the composer, talking about a terminal that was
  // no longer on screen.
  //
  // It is hidden rather than unmounted. The sign-in is still live — the CLI is
  // mid-TUI in that terminal — so the phase, its command and its "I've
  // finished" handler all have to survive the trip to another tab and back.
  //
  // Only `"hidden"` hides it. If the tab is CLOSED the dock stays put, because
  // then there is nowhere left to finish the login and the dock is the only
  // thing offering a way out of it.
  const terminalPresence = useCommandTerminalPresence(
    phase.kind === "terminal" ? (phase.terminal ?? null) : null,
  );
  const dockOffScreen = phase.kind === "terminal" && terminalPresence === "hidden";

  return (
    <Dialog.Root
      open
      modal={!docked}
      // Base UI folds Radix's per-interaction dismiss callbacks into
      // onOpenChange: the reason says which one fired and `cancel()` is the
      // old `event.preventDefault()`. Both rules below used to live on the
      // docked Popup as onInteractOutside / onEscapeKeyDown.
      onOpenChange={(open, details) => {
        if (open) return;
        // A click outside is not a dismissal while docked — the dock has no
        // overlay, so "outside" is the whole app, and clicking into the very
        // terminal it is about would silently kill the sign-in.
        if (docked && (details.reason === "outside-press" || details.reason === "focus-out")) {
          details.cancel();
          return;
        }
        // Escape closes it, EXCEPT while a login is being driven in the
        // terminal, where Esc is a key the TUI itself uses; there the ✕ is
        // the way out.
        if (details.reason === "escape-key" && phase.kind === "terminal") {
          details.cancel();
          return;
        }
        dismiss();
      }}
    >
      <Dialog.Portal>
        {!docked && <DialogOverlay blur />}
        {docked ? (
          <Dialog.Popup
            // Never take the keyboard: the terminal behind this is what the
            // user is typing into. The outside-press and Escape rules that
            // used to sit here are now reasons handled on the Root's
            // onOpenChange.
            initialFocus={false}
            className={cn(
              "fixed bottom-12 left-1/2 z-modal max-w-[92vw] -translate-x-1/2",
              // `hidden` and not an opacity fade: the dock must leave the
              // accessibility tree and stop taking pointer events while the
              // user is on another tab, not merely stop being visible.
              dockOffScreen && "hidden",
            )}
            style={centred}
          >
            <SignInDock label={label}>
              {phase.kind === "terminal" ? (
                <TerminalHandoffDockBody
                  command={phase.command}
                  onDone={() => void confirmTerminalSignIn(phase.method)}
                  onDismiss={dismiss}
                />
              ) : phase.kind === "done" ? (
                <span className="text-sm text-success">Signed in to {label}.</span>
              ) : (
                <>
                  <Loader2 size={13} className="shrink-0 animate-spin text-muted-foreground" />
                  <span className="text-sm text-secondary-foreground">
                    {phase.kind === "running" ? phase.label : `Starting ${label}…`}
                  </span>
                </>
              )}
            </SignInDock>
          </Dialog.Popup>
        ) : (
          <Dialog.Popup
            className={cn(
              "fixed left-1/2 top-[24%] z-modal -translate-x-1/2",
              "w-[480px] max-w-[92vw] rounded-lg border border-border bg-card",
              "shadow-md text-foreground",
            )}
            style={centred}
          >
            <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
              <Info className="mt-0.5 size-4 text-muted-foreground" />
              <div>
                <Dialog.Title className="text-sm font-medium">Sign in to {label}</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-secondary-foreground">
                  {label} needs credentials before it can start a session.
                </Dialog.Description>
              </div>
            </div>

            <div className="p-3">
              {/* No `loading` branch: resolving what the agent offers is not a
                  decision, so it renders in the dock. */}
              {phase.kind === "running" && (
                <RunningPhase label={phase.label} tail={tail} url={authUrl} />
              )}

              {phase.kind === "done" && (
                <div className="px-2 py-6 text-xs text-success">Signed in to {label}.</div>
              )}

              {phase.kind === "error" && (
                <div className="space-y-3">
                  <p className="px-2 text-xs text-error break-words">{phase.message}</p>
                  {phase.manualCommand && (
                    <div className="px-2 space-y-1.5">
                      <p className="text-xs text-secondary-foreground">
                        You can also finish this in a terminal:
                      </p>
                      <button
                        onClick={() => {
                          void copyText(phase.manualCommand!);
                          toast.success("Command copied.");
                        }}
                        title="Copy — then run it in a terminal and try again."
                        className="w-full rounded-sm border border-border bg-background px-2.5 py-1.5 text-left font-mono text-xs text-secondary-foreground break-all hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
                      >
                        {phase.manualCommand}
                      </button>
                    </div>
                  )}
                  <button
                    onClick={() => setNonce((n) => n + 1)}
                    className="ml-2 rounded-sm border border-border px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground"
                  >
                    Try again
                  </button>
                </div>
              )}

              {phase.kind === "env" && (
                <EnvPhase
                  method={phase.method}
                  env={env.filter((e) => e.methodId === phase.method.id)}
                  agentLabel={label}
                  onBack={() => setPhase({ kind: "choose", methods: phase.methods })}
                  onContinue={() => void run(phase.method)}
                />
              )}

              {phase.kind === "choose" && (
                <div className="flex flex-col gap-1.5">
                  {phase.methods.length === 0 && (
                    <p className="px-2 py-4 text-xs text-secondary-foreground">
                      {label} asked for credentials but did not say what it needs, and offered no
                      sign-in method Atlas can run. If it reads a provider API key from the
                      environment, export that variable in your shell profile and {label} will pick
                      it up on its next start.
                    </p>
                  )}
                  {phase.methods.map((m) => (
                    <div key={m.id} className="flex flex-col gap-1">
                      <button
                        onClick={() =>
                          m.kind === "env_var"
                            ? setPhase({ kind: "env", method: m, methods: phase.methods })
                            : void run(m)
                        }
                        className="group flex items-center gap-3 rounded-sm border border-border bg-background px-3 py-2.5 text-left transition-colors hover:bg-element-hover"
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block text-xs font-medium text-foreground">
                            {m.name}
                          </span>
                          {m.description && (
                            <span className="mt-0.5 block text-xs text-secondary-foreground">
                              {m.description}
                            </span>
                          )}
                        </span>
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
                      </button>
                      {/* No separate "run this in a terminal" any more: for a
                        method with a CLI, choosing it IS the terminal
                        hand-off, so a second button would do the same thing. */}
                    </div>
                  ))}
                  {supportsLogout && (
                    <button
                      onClick={() => void signOut()}
                      className="mt-0.5 flex items-center gap-2 self-start rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <LogOut className="size-3.5" /> Sign out of {label}
                    </button>
                  )}
                </div>
              )}
            </div>
          </Dialog.Popup>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Spinner plus the login CLI's live output.
 *
 *  The tail matters more than it looks: a CLI that fails to open the browser is
 *  otherwise indistinguishable from one that is simply slow, and the user has
 *  no signal at all. The URL button is the fallback for exactly that case. */
function RunningPhase({ label, tail, url }: { label: string; tail: string[]; url: string | null }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [tail.length]);

  return (
    <div className="space-y-2.5 px-2 py-3">
      <div className="flex items-center gap-2 text-xs text-secondary-foreground">
        <Loader2 size={14} className="animate-spin" /> {label}
      </div>
      {url && (
        <button
          onClick={() => void openUrl(url)}
          className="flex w-full items-center gap-2 rounded-sm border border-border bg-background px-2.5 py-1.5 text-left text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
        >
          <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Open sign-in page</span>
        </button>
      )}
      {tail.length > 0 && (
        <div className="max-h-28 overflow-y-auto rounded-sm border border-border bg-background px-2.5 py-1.5">
          {tail.map((line, i) => (
            <p key={i} className="font-mono text-xs text-muted-foreground break-all">
              {line}
            </p>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

/** The login is running in a real terminal, because it needs to be typed into.
 *
 *  Atlas deliberately does not guess when it is finished. The command runs in
 *  the user's own shell, not a process Atlas is waiting on, and a browser
 *  hand-off can complete long after the CLI exits — so the user says when, and
 *  the agent's own `authenticate` is what actually verifies it. */
function SignInDock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      // Same frosted-HUD treatment as the hint-nav dock (`hint-overlay.tsx`) —
      // the `glass-hud` utility carries the border, edge and shadow together.
      className="flex items-center gap-2.5 rounded-full py-2 pl-3.5 pr-3 glass-hud backdrop-blur-glass bg-gradient-to-b from-popover/85 to-card/90"
    >
      {/* Radix requires both on every Content; the dock states carry their own
          visible copy, so these are for screen readers only. */}
      <Dialog.Title className="sr-only">Sign in to {label}</Dialog.Title>
      <Dialog.Description className="sr-only">
        {label} needs credentials before it can start a session.
      </Dialog.Description>
      {children}
    </div>
  );
}

/** The dock's terminal-hand-off row. */
function TerminalHandoffDockBody({
  command,
  onDone,
  onDismiss,
}: {
  command: string;
  onDone: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-sm text-foreground">Finish signing in in the terminal</span>

      <button
        onClick={() => {
          void copyText(command);
          toast.success("Command copied.");
        }}
        title={`Copy — ${command}`}
        className="flex h-6.5 min-w-0 items-center gap-1.5 rounded-full border border-border bg-element-hover px-2.5 font-mono text-xs leading-none text-muted-foreground transition-colors hover:bg-element-active hover:text-foreground"
      >
        <span className="min-w-0 max-w-[220px] truncate">{command}</span>
        <Copy className="size-3 shrink-0" />
      </button>

      {/* Pill button, matching the transcript's "N new messages" jump control
          (`chat-panel.tsx`) — same radius and weight, sized to this row. */}
      <button
        onClick={onDone}
        className="flex h-6.5 shrink-0 items-center rounded-full border border-border bg-element-selected px-3 text-xs font-medium leading-none text-foreground transition-colors hover:bg-[var(--atlas-element-emphasis)]"
      >
        I've finished signing in
      </button>

      <Hint label="Dismiss" side="top">
        <button
          onClick={onDismiss}
          className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-element-active hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </Hint>
    </>
  );
}

/** Read-only checklist for an `env_var` method.
 *
 *  There is no input field on purpose. For ACP agents, credentials live in the
 *  system environment — Atlas reads them, it does not store them (the plan's
 *  token-free delegation invariant). Taking a key here would create an
 *  Atlas-held secret for an agent that reads `process.env` anyway. */
function EnvPhase({
  method,
  env,
  agentLabel,
  onBack,
  onContinue,
}: {
  method: AuthMethodWire;
  env: AuthEnvStatus[];
  agentLabel: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  const blocked = useMemo(() => methodBlockedReason(method, env), [method, env]);
  return (
    <div className="flex flex-col gap-2.5 px-2 py-1">
      <p className="text-xs text-secondary-foreground">
        {agentLabel} reads these from your environment. Export them in your shell profile (
        <code className="text-xs text-foreground">~/.zshrc</code>) and they are picked up on its
        next start.
      </p>
      <div className="flex flex-col gap-1">
        {env.map((v) => (
          <div
            key={v.name}
            className="flex items-center gap-2 rounded-sm border border-border bg-background px-2.5 py-1.5"
          >
            <Check
              className={cn(
                "size-3.5 shrink-0",
                v.satisfied ? "text-success" : "text-muted-foreground opacity-40",
              )}
            />
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {v.name}
            </code>
            <span className="shrink-0 text-xs text-muted-foreground">
              {v.satisfied
                ? v.source === "shell-env"
                  ? "from shell profile"
                  : "from environment"
                : v.optional
                  ? "optional"
                  : "not set"}
            </span>
          </div>
        ))}
      </div>
      {method.link && (
        <button
          onClick={() => void openUrl(method.link!)}
          className="flex items-center gap-2 self-start rounded-sm border border-border px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground"
        >
          <ExternalLink className="size-3.5" /> Get API key
        </button>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onContinue}
          disabled={blocked !== null}
          title={blocked ?? undefined}
          className="h-7 rounded-sm border border-border px-2.5 text-xs text-foreground hover:bg-element-hover disabled:opacity-50 disabled:hover:bg-transparent"
        >
          Continue
        </button>
        <button
          onClick={onBack}
          className="h-7 rounded-sm px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Other sign-in options
        </button>
      </div>
    </div>
  );
}
