import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { KbdCombo } from "@/ui/kbd";
import { comboFromEvent, formatCombo, serializeCombo, type Combo } from "../lib/combo";
import { setChordRecording } from "../lib/recording";
import { reservedReason } from "../lib/reserved";

/**
 * "Press the keys you want." Captures one chord and hands it back.
 *
 * Takes over the keyboard entirely while it is mounted — capture phase,
 * `stopImmediatePropagation`, and the dispatcher stood down via
 * `setChordRecording` — because every chord worth binding is also a chord that
 * would otherwise do something. Escape cancels rather than being recorded; a
 * user who wants Escape bound can say so in `config.toml`, and losing the way
 * out of this control would be the worse trade.
 */
export function ShortcutRecorder({
  onRecorded,
  onCancel,
}: {
  onRecorded: (combo: Combo) => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState<Combo | null>(null);

  useEffect(() => {
    setChordRecording(true);
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      const combo = comboFromEvent(e);
      // Null while only modifiers are held — that is the "…" state, not a
      // chord, and showing it is what makes the control feel live.
      if (combo) setPending(combo);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setChordRecording(false);
    };
  }, [onCancel]);

  const reserved = pending && reservedReason(pending);

  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          "flex h-[22px] min-w-[120px] items-center justify-center gap-1 rounded-md px-2",
          "border border-[var(--accent)] bg-bg-elevated",
        )}
      >
        {pending ? (
          <KbdCombo combo={formatCombo(pending)} />
        ) : (
          <span className="text-[10px] text-text-tertiary">Press a shortcut…</span>
        )}
      </div>
      {reserved && (
        <span className="max-w-[240px] text-[10px] text-[var(--status-warning)]">{reserved}</span>
      )}
      <button
        type="button"
        disabled={!pending}
        onClick={() => pending && onRecorded(pending)}
        className={cn(
          "rounded-md border border-border-default px-2 py-0.5 text-[10px] text-text-secondary",
          "hover:border-[var(--border-strong)] disabled:opacity-40",
        )}
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-border-default px-2 py-0.5 text-[10px] text-text-secondary hover:border-[var(--border-strong)]"
      >
        Cancel
      </button>
      {pending && (
        <span className="font-mono text-[10px] text-text-tertiary">{serializeCombo(pending)}</span>
      )}
    </div>
  );
}
