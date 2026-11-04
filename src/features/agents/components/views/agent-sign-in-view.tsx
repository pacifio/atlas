// The agent sign-in surface, props only: a modal dialog while the user must
// decide or read something, and a non-modal pill docked over the centre panel
// while there is nothing to act on (`isDocked`). The flow, IPC, terminal and
// timers are the container's (`agent-oauth-modal.tsx`).
//
// The dialog keeps the frosted scrim the package reserves for blocking
// prompts (`DialogOverlay blur`), which `DialogContent`'s own overlay cannot
// carry, so it is composed from the package's dialog parts. The dock has no
// overlay at all, and the package has no popup without one, so it is a bare
// Base UI popup.

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Info } from "lucide-react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  Icon,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import {
  isDocked,
  type AuthEnvStatus,
  type AuthMethodWire,
  type SignInPhase,
} from "../../lib/sign-in-methods";
import {
  ChooseStep,
  DockStatus,
  DoneStep,
  EnvStep,
  ErrorStep,
  RunningStep,
  TerminalDock,
} from "./agent-sign-in-steps-view";

export function AgentSignInView({
  label,
  phase,
  env,
  tail,
  authUrl,
  supportsLogout,
  centerX,
  dockHidden,
  onChooseMethod,
  onBackToMethods,
  onContinueEnv,
  onRetry,
  onSignOut,
  onOpenUrl,
  onCopyCommand,
  onTerminalDone,
  onDismiss,
}: {
  label: string;
  phase: SignInPhase;
  /** The env checklist's variables, already filtered to the method. */
  env: AuthEnvStatus[];
  /** Live tail of the login CLI, and the first URL it printed. */
  tail: string[];
  authUrl: string | null;
  supportsLogout: boolean;
  /** The centre panel's middle, so the surface centres on the content rather
   *  than the window; `null` falls back to the window's middle. */
  centerX: number | null;
  /** The terminal the dock is about is on another tab: take the dock out of
   *  the way (and the accessibility tree) until it is back. */
  dockHidden: boolean;
  onChooseMethod: (method: AuthMethodWire) => void;
  onBackToMethods: () => void;
  onContinueEnv: () => void;
  onRetry: () => void;
  onSignOut: () => void;
  onOpenUrl: (url: string) => void;
  onCopyCommand: (command: string) => void;
  onTerminalDone: () => void;
  onDismiss: () => void;
}) {
  const docked = isDocked(phase);
  const centred = centerX != null ? { left: centerX } : undefined;

  return (
    <Dialog
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
        onDismiss();
      }}
    >
      <DialogPortal>
        {!docked && <DialogOverlay blur />}
        {docked ? (
          <DialogPrimitive.Popup
            // Never take the keyboard: the terminal behind this is what the
            // user is typing into.
            initialFocus={false}
            data-testid="sign-in-dock"
            className={cn(
              "fixed bottom-12 left-1/2 z-modal max-w-[92vw] -translate-x-1/2",
              // `hidden` and not an opacity fade: the dock must leave the
              // accessibility tree and stop taking pointer events while the
              // user is on another tab, not merely stop being visible.
              dockHidden && "hidden",
            )}
            style={centred}
          >
            <div
              // Same frosted-HUD treatment as the hint-nav dock — the
              // `glass-hud` utility carries the border, edge and shadow
              // together.
              className="glass-hud flex items-center gap-2.5 rounded-full bg-gradient-to-b from-popover/85 to-card/90 py-2 pr-3 pl-3.5 backdrop-blur-glass"
            >
              {/* Every popup needs a title and description; the dock states
                  carry their own visible copy, so these are for screen
                  readers only. */}
              <DialogTitle className="sr-only">Sign in to {label}</DialogTitle>
              <DialogDescription className="sr-only">
                {label} needs credentials before it can start a session.
              </DialogDescription>
              {phase.kind === "terminal" ? (
                <TerminalDock
                  command={phase.command}
                  onCopyCommand={onCopyCommand}
                  onDone={onTerminalDone}
                  onDismiss={onDismiss}
                />
              ) : (
                <DockStatus
                  done={phase.kind === "done"}
                  text={
                    phase.kind === "done"
                      ? `Signed in to ${label}.`
                      : phase.kind === "running"
                        ? phase.label
                        : `Starting ${label}…`
                  }
                />
              )}
            </div>
          </DialogPrimitive.Popup>
        ) : (
          <DialogPrimitive.Popup
            data-testid="sign-in-dialog"
            // The package dialog's surface, a quarter down the window like
            // every blocking prompt, centred on the content.
            className="fixed top-[24%] left-1/2 z-modal w-[480px] max-w-[92vw] -translate-x-1/2 rounded-xl border border-border bg-card text-foreground shadow-lg outline-none data-open:animate-scale-in data-closed:animate-scale-out"
            style={centred}
          >
            <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
              <Icon icon={Info} size="lg" className="mt-0.5 shrink-0 text-muted-foreground" />
              <DialogHeader>
                <DialogTitle>Sign in to {label}</DialogTitle>
                <DialogDescription>
                  {label} needs credentials before it can start a session.
                </DialogDescription>
              </DialogHeader>
            </div>

            <div className="p-3">
              {/* No `loading` branch: resolving what the agent offers is not a
                  decision, so it renders in the dock. */}
              {phase.kind === "running" && (
                <RunningStep
                  label={phase.label}
                  tail={tail}
                  authUrl={authUrl}
                  onOpenUrl={onOpenUrl}
                />
              )}
              {phase.kind === "done" && <DoneStep label={label} />}
              {phase.kind === "error" && (
                <ErrorStep
                  message={phase.message}
                  manualCommand={phase.manualCommand}
                  onCopyCommand={onCopyCommand}
                  onRetry={onRetry}
                />
              )}
              {phase.kind === "env" && (
                <EnvStep
                  label={label}
                  method={phase.method}
                  env={env}
                  onOpenUrl={onOpenUrl}
                  onContinue={onContinueEnv}
                  onBack={onBackToMethods}
                />
              )}
              {phase.kind === "choose" && (
                <ChooseStep
                  label={label}
                  methods={phase.methods}
                  supportsLogout={supportsLogout}
                  onChooseMethod={onChooseMethod}
                  onSignOut={onSignOut}
                />
              )}
            </div>
          </DialogPrimitive.Popup>
        )}
      </DialogPortal>
    </Dialog>
  );
}
