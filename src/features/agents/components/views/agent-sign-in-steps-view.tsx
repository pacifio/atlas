// The agent sign-in modal's steps, one props-only component each. The dialog
// steps (choose, env, running, error, done) sit inside `AgentSignInView`'s
// dialog; the dock bodies (terminal hand-off, status) inside its pill.
//
// Nothing here names an agent (ADR-0002): every label arrives as a prop.

import { useEffect, useMemo, useRef } from "react";
import { Check, ChevronRight, Copy, ExternalLink, LogOut, Terminal, X } from "lucide-react";
import { Badge, Button, Callout, Code, Hint, Icon, IconButton, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import {
  envStatusLabel,
  methodBlockedReason,
  type AuthEnvStatus,
  type AuthMethodWire,
} from "../../lib/sign-in-methods";

/** Pick how to sign in: one row per method the agent advertised. */
export function ChooseStep({
  label,
  methods,
  supportsLogout,
  onChooseMethod,
  onSignOut,
}: {
  label: string;
  methods: AuthMethodWire[];
  /** Only agents that advertised `auth.logout` get a sign-out action. */
  supportsLogout: boolean;
  onChooseMethod: (method: AuthMethodWire) => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {methods.length === 0 && (
        <p className="px-2 py-4 text-xs text-secondary-foreground">
          {label} asked for credentials but did not say what it needs, and offered no sign-in method
          Atlas can run. If it reads a provider API key from the environment, export that variable
          in your shell profile and {label} will pick it up on its next start.
        </p>
      )}
      {methods.map((m) => (
        // No separate "run this in a terminal": for a method with a CLI,
        // choosing it IS the terminal hand-off, so a second button would do
        // the same thing.
        <button
          key={m.id}
          type="button"
          onClick={() => onChooseMethod(m)}
          className="group flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-element-hover"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-foreground">{m.name}</span>
            {m.description && (
              <span className="mt-0.5 block text-xs text-secondary-foreground">
                {m.description}
              </span>
            )}
          </span>
          <Icon
            icon={ChevronRight}
            size="md"
            className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
          />
        </button>
      ))}
      {supportsLogout && (
        <div className="mt-0.5">
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <Icon icon={LogOut} size="md" />
            Sign out of {label}
          </Button>
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
export function EnvStep({
  label,
  method,
  env,
  onOpenUrl,
  onContinue,
  onBack,
}: {
  label: string;
  method: AuthMethodWire;
  /** This method's variables only. */
  env: AuthEnvStatus[];
  onOpenUrl: (url: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const blocked = useMemo(() => methodBlockedReason(method, env), [method, env]);
  return (
    <div className="flex flex-col gap-2.5 px-2 py-1">
      <p className="text-xs text-secondary-foreground">
        {label} reads these from your environment. Export them in your shell profile (
        <Code>~/.zshrc</Code>) and they are picked up on its next start.
      </p>
      <div className="flex flex-col gap-1">
        {env.map((v) => (
          <div
            key={v.name}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
          >
            <Icon
              icon={Check}
              size="md"
              className={cn("shrink-0", v.satisfied ? "text-success" : "text-muted-foreground/40")}
            />
            <span className="min-w-0 flex-1 truncate">
              <Code>{v.name}</Code>
            </span>
            <Badge size="sm" variant={v.satisfied ? "success" : v.optional ? "outline" : "warning"}>
              {envStatusLabel(v)}
            </Badge>
          </div>
        ))}
      </div>
      {method.link && (
        <div>
          <Button variant="outline" size="sm" onClick={() => onOpenUrl(method.link!)}>
            <Icon icon={ExternalLink} size="md" />
            Get API key
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="md"
          onClick={onContinue}
          disabled={blocked !== null}
          title={blocked ?? undefined}
        >
          Continue
        </Button>
        <Button variant="ghost" size="md" onClick={onBack}>
          Other sign-in options
        </Button>
      </div>
    </div>
  );
}

/** Spinner plus the login CLI's live output.
 *
 *  The tail matters more than it looks: a CLI that fails to open the browser is
 *  otherwise indistinguishable from one that is simply slow, and the user has
 *  no signal at all. The URL button is the fallback for exactly that case. */
export function RunningStep({
  label,
  tail,
  authUrl,
  onOpenUrl,
}: {
  label: string;
  tail: string[];
  authUrl: string | null;
  onOpenUrl: (url: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [tail.length]);

  return (
    <div className="space-y-2.5 px-2 py-3">
      <div className="flex items-center gap-2 text-xs text-secondary-foreground">
        <Spinner size="md" label="" /> {label}
      </div>
      {authUrl && (
        <div>
          <Button variant="outline" size="sm" onClick={() => onOpenUrl(authUrl)}>
            <Icon icon={ExternalLink} size="md" />
            Open sign-in page
          </Button>
        </div>
      )}
      {tail.length > 0 && (
        <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-background px-2.5 py-1.5">
          {tail.map((line, i) => (
            <p key={i} className="code text-xs break-all text-muted-foreground">
              {line}
            </p>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

/** A failure, and the two ways forward: run the command by hand, or retry. */
export function ErrorStep({
  message,
  manualCommand,
  onCopyCommand,
  onRetry,
}: {
  message: string;
  manualCommand?: string;
  onCopyCommand: (command: string) => void;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-3 px-2">
      <Callout tone="error">
        <span className="break-words">{message}</span>
      </Callout>
      {manualCommand && (
        <div className="space-y-1.5">
          <p className="text-xs text-secondary-foreground">
            You can also finish this in a terminal:
          </p>
          <button
            type="button"
            onClick={() => onCopyCommand(manualCommand)}
            title="Copy — then run it in a terminal and try again."
            className="w-full cursor-pointer rounded-md border border-border bg-background px-2.5 py-1.5 text-left transition-colors hover:bg-element-hover"
          >
            <Code className="break-all">{manualCommand}</Code>
          </button>
        </div>
      )}
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** The success frame, shown briefly before the dialog closes. */
export function DoneStep({ label }: { label: string }) {
  return (
    <div className="px-2 py-4">
      <Callout tone="success">Signed in to {label}.</Callout>
    </div>
  );
}

/** The dock's terminal hand-off row.
 *
 *  Atlas deliberately does not guess when the login is finished. The command
 *  runs in the user's own shell, not a process Atlas is waiting on, and a
 *  browser hand-off can complete long after the CLI exits — so the user says
 *  when, and the agent's own `authenticate` is what actually verifies it. */
export function TerminalDock({
  command,
  onCopyCommand,
  onDone,
  onDismiss,
}: {
  command: string;
  onCopyCommand: (command: string) => void;
  onDone: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <Icon icon={Terminal} size="md" className="shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-sm text-foreground">Finish signing in in the terminal</span>

      <button
        type="button"
        onClick={() => onCopyCommand(command)}
        title={`Copy — ${command}`}
        className="flex h-6.5 min-w-0 items-center gap-1.5 rounded-full border border-border bg-element-hover px-2.5 font-mono text-xs leading-none text-muted-foreground transition-colors hover:bg-element-active hover:text-foreground"
      >
        <span className="max-w-[220px] min-w-0 truncate">{command}</span>
        <Icon icon={Copy} size="sm" className="shrink-0" />
      </button>

      <Button variant="default" size="sm" onClick={onDone}>
        I've finished signing in
      </Button>

      <Hint label="Dismiss" side="top">
        <IconButton icon={X} label="Dismiss" size="sm" onClick={onDismiss} />
      </Hint>
    </>
  );
}

/** The dock while there is nothing to act on: resolving the agent's methods,
 *  a one-call check, or the success frame. */
export function DockStatus({ text, done }: { text: string; done: boolean }) {
  return done ? (
    <span className="text-sm text-success">{text}</span>
  ) : (
    <>
      <Spinner size="sm" label="" />
      <span className="text-sm text-secondary-foreground">{text}</span>
    </>
  );
}
