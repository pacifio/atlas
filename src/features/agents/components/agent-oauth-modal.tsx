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
// method-row button, same `text-xs`/`text-[11px]` scale, same tokens. No new
// visual patterns — see the design-language rule in the plan.
//
// One method type per branch, mirroring ACP:
//   `agent`    → call `authenticate(methodId)` and let the CLI drive itself.
//   `terminal` → run the login CLI, tail its output live, surface the OAuth URL
//                as a fallback when the browser hand-off fails, then
//                `authenticate()`.
//   `env_var`  → a read-only checklist of variables the user must export. There
//                is deliberately NO key input: for ACP agents, credentials live
//                in the system environment (the plan's BYOK-maps-to-env
//                contract), and Atlas holds no agent tokens.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, Loader2, Info, Check, ExternalLink, LogOut } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import {
  agents,
  ensureAgent,
  listenAuthRunProgress,
  type AuthEnvStatus,
  type AuthMethodWire,
} from "@/features/chat/lib/agents-api";
import {
  AGENT_SIGNIN_EVENT,
  errInfo,
  runSignInMethod,
  takeSignInCallback,
  type AgentSignInRequest,
} from "@/features/chat/lib/agent-signin";
import { detectKeyNeed, envVarsForProvider } from "@/features/chat/lib/agent-key-need";
import { copyText } from "@/lib/clipboard";
import { pluginIdForAgent } from "@/types/agent";
import { agentMeta, catalogEntry } from "@/features/agents/lib/agent-meta";
import { logEvent } from "@/features/log/lib/log";
import { onAuthenticatedFor } from "../lib/agent-auth-hooks";

/** Lifted verbatim from `agent-login-dialog.tsx` — one machine for all agents. */
type Phase =
  | { kind: "loading" }
  | { kind: "choose"; methods: AuthMethodWire[] }
  /** An `env_var` method: nothing to run until the shell provides the vars. */
  | { kind: "env"; method: AuthMethodWire; methods: AuthMethodWire[] }
  | { kind: "running"; label: string }
  /** `manualCommand` is the escape hatch when Atlas could not drive the login
   *  itself: opencode/kilo's TUI login cannot be driven headlessly, and any CLI
   *  can fail for its own reasons. Built from the method's own resolved
   *  command, so it is correct even when the binary lives in Atlas's app-data
   *  dir rather than on the user's PATH. */
  | { kind: "error"; message: string; manualCommand?: string }
  | { kind: "done" };

/** POSIX-quote a token so a path with spaces survives a paste into a shell. */
function shellQuote(token: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The command a user can run by hand to finish this sign-in, or null when the
 *  method has no terminal spec to offer. */
export function manualCommandFor(method: AuthMethodWire): string | null {
  if (!method.terminalCommand) return null;
  return [method.terminalCommand, ...(method.terminalArgs ?? [])].map(shellQuote).join(" ");
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
        setPhase(pointed ? { kind: "env", method: pointed, methods } : { kind: "choose", methods });
      } catch (err) {
        // `agents_spawn` rejects with a structured `{message, kind}`.
        if (!cancelled) setPhase({ kind: "error", message: errInfo(err).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request.agentType, request.requestId, request.reason, nonce, refreshEnv]);

  // The user exports a var in their shell and comes back — re-check without
  // making them reopen the modal.
  useEffect(() => {
    if (!agentId) return;
    const handler = () => void refreshEnv(agentId);
    window.addEventListener("atlas:byok-env-updated", handler);
    return () => window.removeEventListener("atlas:byok-env-updated", handler);
  }, [agentId, refreshEnv]);

  const finish = () => {
    setPhase({ kind: "done" });
    takeSignInCallback(request.requestId)?.onSignedIn?.();
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
    setTail([]);
    setAuthUrl(null);
    setPhase({ kind: "running", label: `Signing in to ${label}…` });

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
      await onAuthenticatedFor(request.agentType);
      logEvent({
        source: "atlas",
        kind: "agent-auth",
        summary: `${label} signed in (${method.id})`,
        status: "success",
        payload: { agent: request.agentType, method: method.id },
      });
      finish();
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

  /** ACP `logout` (A2) — the agent drops its own credentials; Atlas holds none
   *  to clear. Offered only when the agent advertised the capability, so this
   *  never presents an action that would 404 on the wire. */
  const signOut = async () => {
    if (!agentId) return;
    setPhase({ kind: "running", label: `Signing out of ${label}…` });
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
    // Reached on ANY close; after a successful sign-in the callbacks were
    // already taken above, so this take() is a no-op then. On a real dismissal
    // it lets the caller re-arm its failure reporting — without it one Esc
    // permanently silenced every later bind failure for the tab.
    takeSignInCallback(request.requestId)?.onDismissed?.();
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && dismiss()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-[24%] z-[var(--z-modal)] -translate-x-1/2",
            "w-[480px] max-w-[92vw] rounded-lg border border-border-default bg-bg-elevated",
            "shadow-[var(--shadow-overlay)] text-text-primary",
          )}
        >
          <div className="flex items-start gap-2.5 border-b border-border-default px-4 py-3">
            <Info className="mt-0.5 size-4 text-text-tertiary" />
            <div>
              <Dialog.Title className="text-sm font-medium">Sign in to {label}</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-secondary">
                {label} needs credentials before it can start a session.
              </Dialog.Description>
            </div>
          </div>

          <div className="p-3">
            {phase.kind === "loading" && (
              <div className="flex items-center gap-2 px-2 py-6 text-xs text-text-secondary">
                <Loader2 size={14} className="animate-spin" /> Starting {label}…
              </div>
            )}

            {phase.kind === "running" && (
              <RunningPhase label={phase.label} tail={tail} url={authUrl} />
            )}

            {phase.kind === "done" && (
              <div className="px-2 py-6 text-xs text-[var(--status-success)]">
                Signed in to {label}.
              </div>
            )}

            {phase.kind === "error" && (
              <div className="space-y-3">
                <p className="px-2 text-xs text-[var(--status-error)] break-words">
                  {phase.message}
                </p>
                {phase.manualCommand && (
                  <div className="px-2 space-y-1.5">
                    <p className="text-[11px] text-text-secondary">
                      You can also finish this in a terminal:
                    </p>
                    <button
                      onClick={() => {
                        void copyText(phase.manualCommand!);
                        toast.success("Command copied.");
                      }}
                      title="Copy — then run it in a terminal and try again."
                      className="w-full rounded-sm border border-border-default bg-bg-base px-2.5 py-1.5 text-left font-mono text-[11px] text-text-secondary break-all hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                    >
                      {phase.manualCommand}
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setNonce((n) => n + 1)}
                  className="ml-2 rounded-sm border border-border-default px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
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
                  <p className="px-2 py-4 text-xs text-text-secondary">
                    {label} asked for credentials but did not say what it needs, and offered no
                    sign-in method Atlas can run. If it reads a provider API key from the
                    environment, export that variable in your shell profile and {label} will pick it
                    up on its next start.
                  </p>
                )}
                {phase.methods.map((m) => (
                  <button
                    key={m.id}
                    onClick={() =>
                      m.kind === "env_var"
                        ? setPhase({ kind: "env", method: m, methods: phase.methods })
                        : void run(m)
                    }
                    className="group flex items-center gap-3 rounded-sm border border-border-default bg-bg-base px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium text-text-primary">{m.name}</span>
                      {m.description && (
                        <span className="mt-0.5 block text-[11px] text-text-secondary">
                          {m.description}
                        </span>
                      )}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-text-tertiary group-hover:text-text-primary transition-colors" />
                  </button>
                ))}
                {supportsLogout && (
                  <button
                    onClick={() => void signOut()}
                    className="mt-0.5 flex items-center gap-2 self-start rounded-sm px-2 py-1 text-xs text-text-tertiary transition-colors hover:text-text-primary"
                  >
                    <LogOut className="size-3.5" /> Sign out of {label}
                  </button>
                )}
              </div>
            )}
          </div>
        </Dialog.Content>
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
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <Loader2 size={14} className="animate-spin" /> {label}
      </div>
      {url && (
        <button
          onClick={() => void openUrl(url)}
          className="flex w-full items-center gap-2 rounded-sm border border-border-default bg-bg-base px-2.5 py-1.5 text-left text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <ExternalLink className="size-3.5 shrink-0 text-text-tertiary" />
          <span className="min-w-0 flex-1 truncate">Open sign-in page</span>
        </button>
      )}
      {tail.length > 0 && (
        <div className="max-h-28 overflow-y-auto rounded-sm border border-border-default bg-bg-base px-2.5 py-1.5">
          {tail.map((line, i) => (
            <p key={i} className="font-mono text-[11px] text-text-tertiary break-all">
              {line}
            </p>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
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
      <p className="text-xs text-text-secondary">
        {agentLabel} reads these from your environment. Export them in your shell profile (
        <code className="text-[11px] text-text-primary">~/.zshrc</code>) and they are picked up on
        its next start.
      </p>
      <div className="flex flex-col gap-1">
        {env.map((v) => (
          <div
            key={v.name}
            className="flex items-center gap-2 rounded-sm border border-border-default bg-bg-base px-2.5 py-1.5"
          >
            <Check
              className={cn(
                "size-3.5 shrink-0",
                v.satisfied ? "text-[var(--status-success)]" : "text-text-tertiary opacity-40",
              )}
            />
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-primary">
              {v.name}
            </code>
            <span className="shrink-0 text-[11px] text-text-tertiary">
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
          className="flex items-center gap-2 self-start rounded-sm border border-border-default px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <ExternalLink className="size-3.5" /> Get API key
        </button>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onContinue}
          disabled={blocked !== null}
          title={blocked ?? undefined}
          className="h-7 rounded-sm border border-border-default px-2.5 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
        >
          Continue
        </button>
        <button
          onClick={onBack}
          className="h-7 rounded-sm px-2 text-xs text-text-tertiary hover:text-text-primary"
        >
          Other sign-in options
        </button>
      </div>
    </div>
  );
}
