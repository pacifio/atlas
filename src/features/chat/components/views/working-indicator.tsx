import { cn } from "@/lib/utils";
import { CONTENT_COLUMN } from "../../lib/row-metrics";
import { LoadingState, WAITING_LABEL } from "../loading-state";

/**
 * Shown while a turn is live but has produced nothing to render yet: the ACP
 * round-trip, the model's first tokens, the beat before the first tool call.
 * Without it the transcript sits completely unchanged after send, which reads
 * as the message having been dropped.
 *
 * A pixel-grid wavefront, a shimmering label and an elapsed timer rather than a
 * spinner — see `loading-state.tsx` and the shimmer's note in `globals.css`.
 * The timer matters here specifically: this is the one moment in a turn with no
 * other evidence that anything is happening, and "42.4s" answers the question
 * the reader is actually asking. It occupies a fixed-height row so its arrival
 * and departure don't jolt the thread it sits under.
 */
export function WorkingIndicator({
  label = WAITING_LABEL,
  onStallRestart,
  onStallSwitch,
  onStallCopyDiagnostics,
}: {
  label?: string;
  onStallRestart?: () => void;
  onStallSwitch?: () => void;
  onStallCopyDiagnostics?: () => void;
}) {
  const stall =
    onStallRestart || onStallSwitch ? (
      <StallNotice
        onRestart={onStallRestart}
        onSwitch={onStallSwitch}
        onCopyDiagnostics={onStallCopyDiagnostics}
      />
    ) : undefined;
  return (
    <div className={cn(CONTENT_COLUMN, "pt-2 pb-3")}>
      <LoadingState label={label} stalledContent={stall} />
    </div>
  );
}

/**
 * The persistent way out of a start that has stalled. Replaces a one-shot
 * toast that said the same thing and then vanished, leaving the user with a
 * "Starting Codex" that never changed. A first run legitimately takes minutes
 * (Node download + `npm install`), so the copy says so; the two actions are
 * the only ones that actually help — killing the wedged connect, or leaving
 * the agent behind.
 */
function StallNotice({
  onRestart,
  onSwitch,
  onCopyDiagnostics,
}: {
  onRestart?: () => void;
  onSwitch?: () => void;
  onCopyDiagnostics?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[17px] text-xs leading-[16px] text-[var(--muted-foreground)]">
      <span className="select-text">Still starting… this can take a few minutes on first run.</span>
      {onRestart && (
        <button
          type="button"
          onClick={onRestart}
          className="cursor-pointer font-medium text-[var(--secondary-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
        >
          Restart agent
        </button>
      )}
      {onSwitch && (
        <button
          type="button"
          onClick={onSwitch}
          className="cursor-pointer font-medium text-[var(--secondary-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
        >
          Switch agent
        </button>
      )}
      {onCopyDiagnostics && (
        <button
          type="button"
          onClick={onCopyDiagnostics}
          className="cursor-pointer font-medium text-[var(--secondary-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
        >
          Copy diagnostics
        </button>
      )}
    </div>
  );
}
