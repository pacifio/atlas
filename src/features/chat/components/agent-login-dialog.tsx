import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { agents, ensureAgent, type AuthMethodWire } from "../lib/agents-api";
import {
  AGENT_SIGNIN_EVENT,
  runSignInMethod,
  takeSignInCallback,
  type AgentSignInRequest,
} from "../lib/agent-signin";
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
  | { kind: "running"; label: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

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
        setPhase({ kind: "choose", methods });
      } catch (err) {
        if (!cancelled) setPhase({ kind: "error", message: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request.agentType, nonce]);

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
      takeSignInCallback(request.requestId)?.onSignedIn?.();
      setTimeout(onClose, 700);
    } catch (err) {
      setPhase({
        kind: "error",
        message: String((err as Error)?.message ?? err),
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

  const dismiss = () => {
    // Reached on ANY close; after a successful sign-in the callbacks were
    // already taken above, so this take() is a no-op then. On a real
    // dismissal it lets the caller re-arm its failure reporting — without it
    // one Esc permanently silenced every later bind failure for the tab.
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
                <button
                  onClick={() => setNonce((n) => n + 1)}
                  className="ml-2 rounded-sm border border-border-default px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  Try again
                </button>
              </div>
            )}

            {phase.kind === "choose" && (
              <div className="flex flex-col gap-1.5">
                {phase.methods.length === 0 && (
                  <p className="px-2 py-4 text-xs text-text-secondary">
                    {label} advertised no auth methods.
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
