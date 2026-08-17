import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, Loader2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { agents, ensureAgent, CODEX_PLUGIN_ID, type AuthMethodWire } from "../lib/agents-api";
import { errInfo } from "../lib/agent-signin";
import { logEvent } from "@/features/log/lib/log";

/**
 * Codex auth chooser — mirrors codex-acp's three advertised auth methods
 * ("Login with ChatGPT" / "Use OPENAI_API_KEY" / "Use CODEX_API_KEY"). Unlike
 * Claude's methods these carry NO terminal command, so each is driven through
 * the ACP `authenticate` RPC (`agents.authenticate`). "Login with ChatGPT" runs
 * codex-acp's local login server + OpenAI browser OAuth and writes
 * `~/.codex/auth.json` with `auth_mode: chatgpt` (the fix for the API-key 401).
 */
type Phase =
  | { kind: "loading" }
  | { kind: "choose"; methods: AuthMethodWire[] }
  | { kind: "running"; label: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

export function CodexLoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [agentId, setAgentId] = useState<string | null>(null);

  // On open: spawn Codex (so it advertises its auth methods) and list them.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase({ kind: "loading" });
    (async () => {
      try {
        const agent = await ensureAgent(CODEX_PLUGIN_ID);
        if (cancelled) return;
        setAgentId(agent.agent_id);
        const methods = await agents.listAuthMethods(agent.agent_id);
        if (cancelled) return;
        setPhase({ kind: "choose", methods });
      } catch (err) {
        // `agents_spawn` rejects with a structured `{message, kind}`.
        if (!cancelled) setPhase({ kind: "error", message: errInfo(err).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const run = async (method: AuthMethodWire) => {
    if (!agentId) return;
    setPhase({
      kind: "running",
      label:
        method.id === "chatgpt"
          ? "Waiting for OpenAI sign-in in your browser…"
          : `Applying ${method.name}…`,
    });
    try {
      if (method.terminalCommand) {
        await agents.runAuthMethod(agentId, method.id);
      } else {
        // ACP authenticate RPC — for "chatgpt" this blocks while the OpenAI
        // OAuth completes in the browser. codex-acp reloads its AuthManager
        // in-process on success, so the SAME (already-bound) agent picks up the
        // new ~/.codex/auth.json — no respawn needed.
        await agents.authenticate(agentId, method.id);
      }
      setPhase({ kind: "done" });
      logEvent({
        source: "atlas",
        kind: "codex-auth",
        summary: `Codex auth via ${method.id}`,
        status: "success",
        payload: { method: method.id },
      });
      setTimeout(() => onOpenChange(false), 700);
    } catch (err) {
      setPhase({ kind: "error", message: String(err) });
      logEvent({
        source: "atlas",
        kind: "codex-auth",
        summary: `Codex auth failed (${method.id})`,
        status: "failure",
        payload: { method: method.id, error: String(err) },
      });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
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
              <Dialog.Title className="text-sm font-medium">Authenticate to Codex CLI</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-secondary">
                Choose one of the following authentication options.
              </Dialog.Description>
            </div>
          </div>

          <div className="p-3">
            {phase.kind === "loading" && (
              <div className="flex items-center gap-2 px-2 py-6 text-xs text-text-secondary">
                <Loader2 size={14} className="animate-spin" /> Starting Codex…
              </div>
            )}

            {phase.kind === "running" && (
              <div className="flex items-center gap-2 px-2 py-6 text-xs text-text-secondary">
                <Loader2 size={14} className="animate-spin" /> {phase.label}
              </div>
            )}

            {phase.kind === "done" && (
              <div className="px-2 py-6 text-xs text-[var(--status-success)]">
                Signed in to Codex.
              </div>
            )}

            {phase.kind === "error" && (
              <div className="space-y-3">
                <p className="px-2 text-xs text-[var(--status-error)] break-words">
                  {phase.message}
                </p>
                <button
                  onClick={() => setPhase({ kind: "loading" })}
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
                    Codex advertised no auth methods.
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
