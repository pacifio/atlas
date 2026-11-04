// The one sign-in surface for every ACP agent (Phase M of
// `plans/atlas-acp-auth-login-loop.md`).
//
// Replaces three copy-pasted dialogs — `AgentLoginDialog` (cursor/opencode/
// kilo), `CodexLoginDialog`, and `ClaudeLoginDialog` — which had drifted into
// three different phase machines and three different renderings of the same
// idea. There is now one container, one `SignInPhase` union, and one host;
// agents differ only in the auth methods they advertise and an optional
// `onAuthenticated` hook.
//
// This file is the container: the host, the flow, its IPC, logging, toasts
// and the terminal handle. The decisions with no UI live in
// `lib/sign-in-methods.ts`; the surface is `views/agent-sign-in-view.tsx`.
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
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  agents,
  ensureAgent,
  listenAuthEnvUpdated,
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
import { copyText } from "@/lib/clipboard";
import { pluginIdForAgent } from "@/types/agent";
import { useCenterPanelCenterX } from "@/features/layout/lib/use-center-panel-x";
import { agentMeta, catalogEntry } from "@/features/agents/lib/agent-meta";
import { logEvent } from "@/features/log/lib/log";
import {
  closeCommandTerminal,
  openCommandTerminal,
  useCommandTerminalPresence,
} from "@/features/terminal/lib/open-command-terminal";
import {
  manualCommandFor,
  methodBlockedReason,
  methodForReason,
  type SignInPhase,
} from "../lib/sign-in-methods";
import { AgentSignInView } from "./views/agent-sign-in-view";

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
  const [phase, setPhase] = useState<SignInPhase>({ kind: "loading" });
  const [agentId, setAgentId] = useState<string | null>(null);
  const [env, setEnv] = useState<AuthEnvStatus[]>([]);
  const [nonce, setNonce] = useState(0); // "Try again" re-runs discovery
  /** Live tail of the login CLI, and the first URL it printed. */
  const [tail, setTail] = useState<string[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  /** A2: only agents that advertised `auth.logout` get a sign-out action. */
  const supportsLogout = catalogEntry(request.agentType)?.supportsLogout ?? false;
  /** False once the dialog is dismissed or unmounted: a sign-in still running
   *  then must not touch this dialog (or close a newer one). */
  const aliveRef = useRef(true);
  /** Bumped by every run, "Try again" and dismissal; a run whose attempt is no
   *  longer current is stale and only logs. */
  const attemptRef = useRef(0);
  /** The success frame's close timer, cleared on dismissal and unmount. */
  const closeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

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
  // making them reopen the modal. Rust announces it as a Tauri event.
  useEffect(() => {
    if (!agentId) return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listenAuthEnvUpdated(() => void refreshEnv(agentId))
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [agentId, refreshEnv]);

  /** True while `attempt` is the dialog's current one and it is still open. */
  const current = (attempt: number) => aliveRef.current && attempt === attemptRef.current;

  const finish = (docked: boolean) => {
    setPhase({ kind: "done", docked });
    takeSignInCallback(request.requestId)?.onSignedIn?.();
    // Closes the agent's sign-in notification episode (toast, center item).
    resolveAgentSignIn(request.agentType);
    // Brief success frame before closing, matching the dialogs this replaces.
    // Stored so a dismissal clears it: left running, it closed a NEWER sign-in.
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (aliveRef.current) onClose();
    }, 700);
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
    const attempt = ++attemptRef.current;
    // Atlas drives this one and tails it, so it needs the dialog's room.
    setPhase({ kind: "running", label: `Signing in to ${label}…`, docked: false });

    // Subscribe BEFORE starting, so no output is missed. Scoped by runId once
    // the run reports one — two agents signing in at once must not cross-talk.
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listenAuthRunProgress((p) => {
        if (p.agentId !== agentId || !current(attempt)) return;
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
      // Dismissed (or retried) meanwhile: the sign-in still landed, so close
      // its notification, but leave the dialog and its callbacks alone.
      if (!current(attempt)) resolveAgentSignIn(request.agentType);
      else finish(false);
    } catch (err) {
      if (current(attempt)) {
        setPhase({
          kind: "error",
          message: errInfo(err).message,
          manualCommand: manualCommandFor(method) ?? undefined,
        });
      }
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
    const attempt = ++attemptRef.current;
    await authenticateAfterCliLogin(agentId, method.id, label);
    if (current(attempt)) finish(true);
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
    // A dismissal cancels the flow: whatever is still running finds its
    // attempt stale, and the success frame's close timer cannot fire.
    attemptRef.current += 1;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
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

  // Centred on the content, not the window: with source control or the
  // project switcher open, `left-1/2` sat the dock half a panel off-centre.
  // `left-1/2` stays as the fallback for a window with no centre panel.
  const centerX = useCenterPanelCenterX();

  // The terminal hand-off dock belongs to ONE tab, and it is `fixed` inside a
  // portal, so nothing about its position tied it to that tab: switching to a
  // session left it floating over the composer, talking about a terminal that
  // was no longer on screen.
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

  const copyCommand = (command: string) => {
    void copyText(command);
    toast.success("Command copied.");
  };

  return (
    <AgentSignInView
      label={label}
      phase={phase}
      env={phase.kind === "env" ? env.filter((e) => e.methodId === phase.method.id) : env}
      tail={tail}
      authUrl={authUrl}
      supportsLogout={supportsLogout}
      centerX={centerX}
      dockHidden={phase.kind === "terminal" && terminalPresence === "hidden"}
      onChooseMethod={(m) =>
        phase.kind === "choose" && m.kind === "env_var"
          ? setPhase({ kind: "env", method: m, methods: phase.methods })
          : void run(m)
      }
      onBackToMethods={() => {
        if (phase.kind === "env") setPhase({ kind: "choose", methods: phase.methods });
      }}
      onContinueEnv={() => {
        if (phase.kind === "env") void run(phase.method);
      }}
      onRetry={() => {
        // A clean start: the old run is stale, and its tail and URL go too.
        attemptRef.current += 1;
        setTail([]);
        setAuthUrl(null);
        setNonce((n) => n + 1);
      }}
      onSignOut={() => void signOut()}
      onOpenUrl={(url) => void openUrl(url)}
      onCopyCommand={copyCommand}
      onTerminalDone={() => {
        if (phase.kind === "terminal") void confirmTerminalSignIn(phase.method);
      }}
      onDismiss={dismiss}
    />
  );
}
