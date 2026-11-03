import type { ReactNode } from "react";
import { AtlasIcon } from "@/components/atlas-icon";
import { KbdKeys } from "@/ui/kbd";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { ACTION_BY_ID } from "../lib/actions";
import { displayKeys, parseCombo } from "../lib/combo";
import { PRESETS, type Preset, type PresetId } from "../lib/presets";
import { baseChords } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { PresetIcon } from "./preset-icon";

/**
 * First run's last step: "which editor are you coming from?" (the dialog
 * itself is `FirstRunDialog`).
 *
 * Every answer writes keybindings.json, "Decide later" included, so it is
 * asked exactly once. Nothing here is permanent — a preset is just a profile
 * afterwards — and the card says where to change it, because a choice made
 * before the user has seen the app is one they will want to revisit.
 */
/** What the user answered: a preset, Atlas's own keys, or "later". */
export type KeymapAnswer = PresetId | "atlas" | "later";

export function KeymapStep({ onChosen }: { onChosen?: (answer: KeymapAnswer) => void }) {
  const { completeOnboarding } = useKeybindingsStore.use.actions();
  const choose = (preset: PresetId | null, answer: KeymapAnswer = preset ?? "atlas") => {
    onChosen?.(answer);
    void completeOnboarding(preset);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Which shortcuts should Atlas use?</DialogTitle>
        <DialogDescription>
          Pick the editor you're coming from and Atlas will match its keys where it has the same
          command.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Choice
          icon={<AtlasIcon size={16} />}
          label="Atlas"
          description="Atlas's own shortcuts."
          keys={paletteKeys(null)}
          onClick={() => choose(null)}
        />
        {PRESETS.map((preset) => (
          <Choice
            key={preset.id}
            icon={<PresetIcon id={preset.id} className="size-4 text-foreground" />}
            label={preset.label}
            description={preset.description}
            keys={paletteKeys(preset)}
            onClick={() => choose(preset.id)}
          />
        ))}
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <span className="text-2xs text-muted-foreground">
          Change this any time in Settings → Keybindings.
        </span>
        <Button variant="ghost" size="sm" onClick={() => choose(null, "later")}>
          Decide later
        </Button>
      </DialogFooter>
    </>
  );
}

function Choice({
  icon,
  label,
  description,
  keys,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  keys: string[] | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2",
        "text-left transition-colors duration-fast hover:bg-element-hover cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground">{label}</span>
          <span className="block truncate text-2xs text-muted-foreground">{description}</span>
        </span>
      </span>
      {keys && <KbdKeys keys={keys} className="shrink-0" />}
    </button>
  );
}

/** The command palette's chord under a preset — one concrete example says
 *  more about what a preset changes than another sentence would. */
function paletteKeys(preset: Preset | null): string[] | null {
  const chord = baseChords(ACTION_BY_ID["nav.commandPalette"], preset)[0];
  const combo = chord ? parseCombo(chord) : null;
  return combo ? displayKeys(combo) : null;
}
