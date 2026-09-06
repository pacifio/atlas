import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { KbdKeys } from "@/ui/kbd";
import { ACTION_BY_ID, type ActionId } from "../lib/actions";
import { type Combo, comboFromEvent, displayKeys, serializeCombo } from "../lib/combo";
import { bindingsForCombo } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";

export type RecorderMode = "change" | "add";

/**
 * "Press desired key combination and then press ENTER." — the floating
 * recorder. While mounted it flips the store's `recording` flag so every
 * dispatcher in the app stays silent, and it consumes keydown in the capture
 * phase so nothing else sees the chord.
 *
 * On the locked Default profile it offers to duplicate instead of recording.
 */
export function KeybindingRecorder({
  actionId,
  mode,
  onClose,
  onShowSame,
}: {
  actionId: ActionId;
  mode: RecorderMode;
  onClose: () => void;
  onShowSame: (combo: Combo) => void;
}) {
  const file = useKeybindingsStore.use.file();
  const resolved = useKeybindingsStore.use.resolved();
  const { setRecording, setBinding, addBinding, duplicateProfile } =
    useKeybindingsStore.use.actions();
  const active = file.profiles.find((p) => p.id === file.activeProfileId);
  const locked = !!active?.builtIn;
  const def = ACTION_BY_ID[actionId];

  const [combo, setCombo] = useState<Combo | null>(null);
  // Modifiers held right now, for the live preview before a key lands.
  const [held, setHeld] = useState<string[]>([]);

  useEffect(() => {
    setRecording(true);
    return () => setRecording(false);
  }, [setRecording]);

  useEffect(() => {
    if (locked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        onClose();
        return;
      }
      const bare = !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey;
      if (e.key === "Enter" && bare && combo) {
        commit(combo);
        return;
      }
      if (e.key === "Backspace" && bare) {
        setCombo(null);
        return;
      }
      const next = comboFromEvent(e);
      if (next) {
        setCombo(next);
        setHeld([]);
      } else {
        setHeld(
          displayKeys({
            code: "",
            meta: e.metaKey,
            ctrl: e.ctrlKey && !e.metaKey,
            shift: e.shiftKey,
            alt: e.altKey,
          }).slice(0, -1),
        );
      }
    };
    const onKeyUp = () => setHeld([]);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combo, locked]);

  const commit = (c: Combo) => {
    const s = serializeCombo(c);
    if (mode === "add") addBinding(actionId, s);
    else setBinding(actionId, [s]);
    onClose();
  };

  const same = combo ? bindingsForCombo(resolved.list, combo, actionId) : [];
  const hard = same.filter(
    (b) => b.when === def.when || b.when === "global" || def.when === "global",
  );

  return (
    <div
      className="absolute inset-0 z-20 flex items-start justify-center pt-[18%]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-[440px] rounded-lg border border-border-default bg-[var(--bg-overlay)]/95 backdrop-blur-xl",
          "shadow-[var(--shadow-overlay)] p-3 animate-in fade-in-0 duration-150",
        )}
      >
        {locked ? (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-text-primary">
              <Lock size={12} className="text-text-tertiary" />
              The Default profile is locked
            </div>
            <p className="text-[11px] leading-relaxed text-text-secondary">
              Default always keeps Atlas's built-in shortcuts. Duplicate it into a new profile to
              change <span className="text-text-primary">{def.title}</span> and anything else.
            </p>
            <div className="flex justify-end gap-2 pt-0.5">
              <button
                type="button"
                onClick={onClose}
                className="h-7 rounded-md px-2.5 text-[11px] font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  duplicateProfile(file.activeProfileId, "My keybindings");
                  // Stay open: the next render sees an editable profile and
                  // the recorder proper takes over.
                }}
                className="h-7 rounded-md px-2.5 text-[11px] font-medium bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90 transition-opacity"
              >
                Duplicate &amp; edit
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="text-center text-[11px] text-text-secondary">
              Press desired key combination and then press{" "}
              <span className="font-medium text-text-primary">ENTER</span>.
              <div className="mt-0.5 text-[10px] text-text-tertiary">
                {mode === "add" ? "Adding a keybinding to" : "Changing the keybinding for"}{" "}
                <span className="text-text-secondary">{def.title}</span>
              </div>
            </div>
            <div
              className={cn(
                "flex h-8 items-center justify-center rounded-md border bg-bg-elevated px-2 font-mono text-[12px]",
                combo
                  ? "border-border-strong text-text-primary"
                  : "border-border-default text-text-muted",
              )}
            >
              {combo
                ? serializeCombo(combo)
                : held.length
                  ? held.join(" ") + " …"
                  : "waiting for keys"}
            </div>
            <div className="flex h-5 items-center justify-center">
              {combo ? <KbdKeys keys={displayKeys(combo)} /> : null}
            </div>
            <div className="flex h-4 items-center justify-center text-[10.5px]">
              {combo && same.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onShowSame(combo)}
                  className={cn(
                    "underline underline-offset-2 hover:opacity-80 transition-opacity cursor-pointer",
                    hard.length ? "text-[var(--status-warning)]" : "text-text-tertiary",
                  )}
                >
                  {same.length} existing {same.length === 1 ? "command has" : "commands have"} this
                  keybinding
                </button>
              ) : combo ? (
                <span className="text-text-muted">No other command uses this keybinding</span>
              ) : (
                <span className="text-text-muted">Esc to cancel · ⌫ to clear</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
