import { useEffect, useState } from "react";
import { Loader2, OctagonX, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@tryatlas/design";

const FORCE_STOP_DELAY_MS = 1500;

type StopPhase = "ready" | "waiting" | "force" | "killing";

interface TerminalStopControlProps {
  active: boolean;
  onInterrupt: () => void;
  onForceStop: () => Promise<boolean>;
  onForceStopped: () => void;
  className?: string;
}

export function TerminalStopControl({
  active,
  onInterrupt,
  onForceStop,
  onForceStopped,
  className,
}: TerminalStopControlProps) {
  const [phase, setPhase] = useState<StopPhase>("ready");

  useEffect(() => {
    if (!active) {
      setPhase("ready");
      return;
    }
    if (phase !== "waiting") return;
    const timer = window.setTimeout(() => setPhase("force"), FORCE_STOP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, phase]);

  if (!active) return null;

  const force = phase === "force";
  const pending = phase === "waiting" || phase === "killing";
  const label =
    phase === "waiting"
      ? "Waiting for process to stop"
      : phase === "killing"
        ? "Force stopping process"
        : force
          ? "Force stop process"
          : "Stop process";
  const shortcut = phase === "ready" ? "Ctrl+C" : undefined;

  const stop = async () => {
    if (!force) {
      setPhase("waiting");
      onInterrupt();
      return;
    }
    setPhase("killing");
    try {
      if (await onForceStop()) onForceStopped();
      else setPhase("ready");
    } catch {
      setPhase("ready");
    }
  };

  return (
    <Hint label={label} shortcut={shortcut} side="top">
      <button
        type="button"
        onClick={() => void stop()}
        disabled={pending}
        aria-label={shortcut ? `${label} (${shortcut})` : label}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors",
          force
            ? "text-error hover:bg-error/10"
            : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
          pending ? "cursor-wait" : "cursor-pointer",
          className,
        )}
      >
        {pending ? (
          <Loader2 size={11} className="animate-spin" />
        ) : force ? (
          <OctagonX size={12} />
        ) : (
          <Square size={9} strokeWidth={3} fill="currentColor" />
        )}
      </button>
    </Hint>
  );
}
