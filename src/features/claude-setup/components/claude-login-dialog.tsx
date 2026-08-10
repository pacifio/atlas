import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, KeyRound, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClaudeSetupStore } from "../stores/claude-setup-store";
import type { AuthMethodWire } from "@/features/chat/lib/agents-api";

/**
 * Sign-in dialog rendered from the live `authMethods` list the ACP
 * adapter (claude-agent-acp) advertised during `initialize`. The host's
 * only job is to spawn the subprocess the adapter handed us — the
 * vendored CLI inside the adapter does its own localhost-loopback OAuth
 * (browser → localhost → CLI). No code paste, no PTY automation, no
 * hand-rolled URL parsing.
 */
export function ClaudeLoginDialog() {
  const open = useClaudeSetupStore.use.loginDialogOpen();
  const authMethods = useClaudeSetupStore.use.authMethods();
  const authRun = useClaudeSetupStore.use.authRun();
  const { loadAuthMethods, runAuthMethod, closeLoginDialog } = useClaudeSetupStore.use.actions();

  // Load the methods list every time the dialog opens. The Rust side
  // already cached them on the AgentManager (per spawned agent), so
  // this is just an IPC round-trip — cheap.
  useEffect(() => {
    if (open) {
      void loadAuthMethods();
    }
  }, [open, loadAuthMethods]);

  const isRunning = authRun.phase === "running";
  const isFailed = authRun.phase === "failed";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeLoginDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[480px] max-w-[92vw] rounded-md border border-border-default bg-bg-elevated shadow-xl",
            "text-text-primary",
          )}
        >
          <div className="flex items-start gap-3 border-b border-border-default px-4 py-3">
            <KeyRound className="mt-0.5 size-4 text-accent" />
            <div className="flex-1">
              <Dialog.Title className="text-sm font-medium">Sign in to Claude Code</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-secondary">
                Atlas runs prompts through the <span className="font-mono">claude-agent-acp</span>{" "}
                adapter. Pick how you'd like to authenticate.
              </Dialog.Description>
            </div>
          </div>

          {/* Chooser — visible until the user picks a method. */}
          {!isRunning && (
            <div className="flex flex-col gap-1.5 px-4 py-3">
              {authMethods.length === 0 ? (
                <div className="inline-flex items-center gap-1.5 text-xs text-text-tertiary px-1 py-2">
                  <Loader2 className="size-3 animate-spin text-accent" />
                  Loading sign-in options…
                </div>
              ) : (
                authMethods.map((m) => (
                  <ChoiceButton key={m.id} method={m} onClick={() => void runAuthMethod(m.id)} />
                ))
              )}
            </div>
          )}

          {/* Waiting — the spawned subprocess opens the browser and waits
              for the localhost callback. We have no progress signal until
              the subprocess exits, so just show a clear waiting state. */}
          {isRunning && (
            <div className="flex flex-col gap-2 px-4 py-3 text-xs">
              <div className="inline-flex items-center gap-1.5 text-text-secondary">
                <Loader2 className="size-3 animate-spin text-accent" />
                Waiting for browser sign-in…
              </div>
              <p className="text-[11px] text-text-tertiary leading-relaxed">
                Your browser should open to the Anthropic sign-in page. Click Authorize and this
                dialog will close automatically.
              </p>
            </div>
          )}

          {isFailed && (
            <div className="flex flex-col gap-1.5 border-t border-border-default px-4 py-2.5 text-xs">
              <p className="text-[11px] text-[var(--status-error)]">{authRun.message}</p>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border-default px-4 py-2.5">
            <button
              type="button"
              onClick={closeLoginDialog}
              className="rounded-sm px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-base hover:text-text-primary"
            >
              {isRunning ? "Cancel" : "Close (ESC)"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ChoiceButton({ method, onClick }: { method: AuthMethodWire; onClick: () => void }) {
  // Methods without a terminal-auth spec can't be run from the host —
  // the adapter expected us to handle them via the ACP `authenticate()`
  // call (gateway path). We don't yet, so disable the row + explain.
  const runnable = method.terminalCommand !== null;
  const description =
    method.description ??
    method.terminalLabel ??
    (runnable ? "Sign in via terminal" : "Not yet supported in Atlas");

  return (
    <button
      type="button"
      onClick={runnable ? onClick : undefined}
      disabled={!runnable}
      className={cn(
        "group flex items-start gap-3 rounded-sm border border-border-default bg-bg-base px-3 py-2.5 text-left",
        "transition-colors",
        runnable ? "hover:bg-bg-hover" : "opacity-50 cursor-not-allowed",
      )}
    >
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium text-text-primary">{method.name}</span>
        <span className="mt-0.5 block text-[11px] text-text-secondary">{description}</span>
      </span>
      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-text-tertiary group-hover:text-text-primary transition-colors" />
    </button>
  );
}
