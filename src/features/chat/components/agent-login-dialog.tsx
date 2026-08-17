import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  agents,
  ensureAgent,
  listenCatalogChanged,
  resetAgent,
  type AuthMethodWire,
} from "../lib/agents-api";
import { detectKeyNeed, type AgentKeyNeed } from "../lib/agent-key-need";
import { byok } from "@/features/settings/lib/byok-api";
import {
  AGENT_SIGNIN_EVENT,
  errInfo,
  runSignInMethod,
  takeSignInCallback,
  type AgentSignInRequest,
} from "../lib/agent-signin";
import { copyText } from "@/lib/clipboard";
import { pluginIdForAgent } from "@/types/agent";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { logEvent } from "@/features/log/lib/log";

/**
 * Sign-in dialog for the auto-managed built-in agents (Cursor / OpenCode /
 * Kilo) — the same modal treatment Claude Code and Codex get, replacing the
 * old actionable toast. Mirrors `CodexLoginDialog`'s shape: spawn the agent,
 * list its advertised auth methods, run the chosen one (CLI browser login +
 * ACP `authenticate`), then fire the caller's retry.
 *
 * One instance lives at the app root (`AgentLoginDialogHost`); lib code opens
 * it by dispatching `AGENT_SIGNIN_EVENT` via `promptSignIn`.
 */
type Phase =
  | { kind: "loading" }
  | { kind: "choose"; methods: AuthMethodWire[] }
  /** The agent wants a provider API key, and Atlas can take it here — no
   *  terminal, no exported env var. Saved to the BYOK keychain, which is
   *  already injected into every agent's spawn env, then the agent is
   *  respawned so it picks the key up. */
  | { kind: "need-key"; need: AgentKeyNeed; methods: AuthMethodWire[] }
  | { kind: "running"; label: string }
  /** `manualCommand` is the escape hatch when Atlas couldn't drive the login
   *  itself: opencode/kilo's TUI login can't be driven headlessly, and any CLI
   *  can fail for its own reasons. Built from the method's own resolved
   *  command, so it is correct even when the binary lives in Atlas's app-data
   *  dir (which is exactly where the old "copy `cursor-agent login`" pill went
   *  wrong — there was no such command on the user's PATH). */
  | { kind: "error"; message: string; manualCommand?: string }
  | { kind: "done" };

/** POSIX-quote a token so a path with spaces survives a paste into a shell. */
function shellQuote(token: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The command a user can run by hand to finish this sign-in, or null when the
 *  method has no terminal spec to offer. */
function manualCommandFor(method: AuthMethodWire): string | null {
  if (!method.terminalCommand) return null;
  return [method.terminalCommand, ...(method.terminalArgs ?? [])].map(shellQuote).join(" ");
}

export function AgentLoginDialogHost() {
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
    <AgentLoginDialog key={request.requestId} request={request} onClose={() => setRequest(null)} />
  );
}

function AgentLoginDialog({
  request,
  onClose,
}: {
  request: AgentSignInRequest;
  onClose: () => void;
}) {
  const label = agentMeta(request.agentType).label;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [agentId, setAgentId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0); // "Try again" re-runs the discovery

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
        // Prefer in-app key entry when the agent's own complaint names a
        // provider key. Most registry agents authenticate ONLY that way, and
        // their advertised methods are frequently unusable — Gemini offers
        // four, none with a runnable command. Asking for the key here is both
        // the shortest path and the only one that stays inside Atlas.
        const need = request.reason ? detectKeyNeed(request.reason) : null;
        setPhase(need ? { kind: "need-key", need, methods } : { kind: "choose", methods });
      } catch (err) {
        // `agents_spawn` rejects with a structured `{message, kind}`.
        if (!cancelled) setPhase({ kind: "error", message: errInfo(err).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request.agentType, nonce]);

  // Discovery can finish AFTER this sheet opened, which is what turns a
  // method with no runnable command into one that has a resolved binary
  // behind it. Re-list when that happens rather than leaving the user
  // looking at a stale "no way to sign in".
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenCatalogChanged(() => setNonce((n) => n + 1)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /** Store the key in Atlas and get the agent running with it.
   *
   *  The respawn is required, not cosmetic: BYOK env is baked into the spawn
   *  spec, so a live process keeps the environment it started with and would
   *  keep refusing. `resetAgent` drops the cached handle so the caller's retry
   *  spawns fresh. */
  const saveKey = async (need: AgentKeyNeed, key: string) => {
    setPhase({ kind: "running", label: `Saving your ${need.label} key…` });
    try {
      await byok.set(need.provider, key.trim());
      resetAgent(pluginIdForAgent(request.agentType));
      setPhase({ kind: "done" });
      logEvent({
        source: "atlas",
        kind: "agent-auth",
        summary: `${label} key stored (${need.provider})`,
        status: "success",
        payload: { agent: request.agentType, provider: need.provider },
      });
      toast.success(`${need.label} key saved. Restarting ${label}…`);
      takeSignInCallback(request.requestId)?.();
      setTimeout(onClose, 700);
    } catch (err) {
      setPhase({ kind: "error", message: errInfo(err).message });
    }
  };

  const run = async (method: AuthMethodWire) => {
    if (!agentId) return;
    setPhase({
      kind: "running",
      label: method.terminalCommand
        ? `Waiting for ${label} sign-in in your browser…`
        : `Applying ${method.name}…`,
    });
    try {
      await runSignInMethod(agentId, method, label);
      setPhase({ kind: "done" });
      logEvent({
        source: "atlas",
        kind: "agent-auth",
        summary: `${label} auth via ${method.id}`,
        status: "success",
        payload: { agent: request.agentType, method: method.id },
      });
      toast.success(`Signed in to ${label}.`);
      takeSignInCallback(request.requestId)?.();
      setTimeout(onClose, 700);
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
        payload: {
          agent: request.agentType,
          method: method.id,
          error: String(err),
        },
      });
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
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
              <div className="flex items-center gap-2 px-2 py-6 text-xs text-text-secondary">
                <Loader2 size={14} className="animate-spin" /> {phase.label}
              </div>
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

            {phase.kind === "need-key" && (
              <KeyEntry
                need={phase.need}
                agentLabel={label}
                onSave={(key) => void saveKey(phase.need, key)}
                // Only worth offering when the agent has something Atlas can
                // actually run; otherwise the key IS the only route.
                onUseAuthMethods={
                  phase.methods.length > 0
                    ? () => setPhase({ kind: "choose", methods: phase.methods })
                    : undefined
                }
              />
            )}

            {phase.kind === "choose" && (
              <div className="flex flex-col gap-1.5">
                {phase.methods.length === 0 && (
                  // Reachable for any external agent now that they get this
                  // dialog — some reject `session/new` for missing credentials
                  // while advertising no way to supply them.
                  <p className="px-2 py-4 text-xs text-text-secondary">
                    {label} asked for credentials but did not say what it needs, and offered no
                    sign-in method Atlas can run. If it uses a provider API key, add that provider
                    under Settings → API Keys and {label} will pick it up on its next start.
                  </p>
                )}
                {phase.methods.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => run(m)}
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
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** In-app provider-key entry — the "nothing outside Atlas" path.
 *
 *  The key goes straight to the OS keychain via BYOK (`byok.set`); it is never
 *  echoed back to the UI and never written to a shell profile. Because Atlas
 *  injects BYOK keys into every agent's spawn env, storing it here is all the
 *  agent needs.
 *
 *  The provider console is shown as plain text rather than a link on purpose:
 *  the point of this dialog is that finishing the task does not require leaving
 *  the app, and a button that navigates away undercuts that. Users who need the
 *  page can copy it. */
function KeyEntry({
  need,
  agentLabel,
  onSave,
  onUseAuthMethods,
}: {
  need: AgentKeyNeed;
  agentLabel: string;
  onSave: (key: string) => void;
  onUseAuthMethods?: () => void;
}) {
  const [key, setKey] = useState("");
  const trimmed = key.trim();
  return (
    <div className="flex flex-col gap-2.5 px-2 py-1">
      <p className="text-xs text-text-secondary">
        {agentLabel} needs a {need.label} API key
        {need.envVar && (
          <>
            {" "}
            (it asked for <code className="text-[11px] text-text-primary">{need.envVar}</code>)
          </>
        )}
        . Paste one here and Atlas will store it in your keychain and restart the agent.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onSave(trimmed);
        }}
        className="flex flex-col gap-2"
      >
        <input
          autoFocus
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={`${need.label} API key`}
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-full rounded-sm border border-border-default bg-bg-base px-2.5 font-mono text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-[var(--border-focus,var(--border-default))]"
        />
        <p className="text-[11px] text-text-tertiary">
          Get one at <span className="text-text-secondary">{need.consoleHint}</span>. Stored in your
          OS keychain and shared with every agent that needs this provider.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!trimmed}
            className="h-7 rounded-sm border border-border-default px-2.5 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Save and restart {agentLabel}
          </button>
          {onUseAuthMethods && (
            <button
              type="button"
              onClick={onUseAuthMethods}
              className="h-7 rounded-sm px-2 text-xs text-text-tertiary hover:text-text-primary"
            >
              Other sign-in options
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
