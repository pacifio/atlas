import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { AtlasIcon } from "@/components/atlas-icon";
import { KbdCombo } from "@/ui/kbd";
import { useProjectStore } from "@/features/project/stores/project-store";
import { formatCombo, parseCombo } from "../lib/combo";
import { PRESETS, type PresetId } from "../lib/presets";
import { useKeybindingsStore } from "../stores/keybindings-store";

/**
 * First run: "which editor are you coming from?"
 *
 * Asked once, answered once — including by declining, which is why "Decide
 * later" records the same marker the other answers do. Nothing here is
 * permanent: the preset is a normal setting afterwards, and the card says so,
 * because a choice presented before the user has seen the app is one they will
 * want to revisit.
 */
export function KeymapOnboarding() {
  const hydrated = useProjectStore.use.hydrated();
  const seen = useKeybindingsStore.use.onboardingSeen();
  const { completeOnboarding } = useKeybindingsStore.use.actions();

  // Waiting for bootstrap: `seen` defaults to false, and asking before the
  // real answer arrives would greet a returning user with a question they
  // already answered.
  const open = hydrated && !seen;

  const choose = (preset?: PresetId) => {
    void completeOnboarding(preset);
  };

  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          // No close button and no dismiss-on-escape: "Decide later" is the
          // dismissal, and it is the one that records an answer.
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-modal)] -translate-x-1/2 -translate-y-1/2",
            "w-[420px] overflow-hidden rounded-2xl",
            "border border-white/10 bg-[var(--bg-elevated)]/70 backdrop-blur-2xl",
            "shadow-[var(--shadow-overlay)] px-5 pb-5 pt-6",
          )}
        >
          <div className="flex flex-col items-center text-center">
            <AtlasIcon size={52} className="rounded-2xl" />
            <Dialog.Title className="mt-3 text-[15px] font-semibold text-text-primary">
              Which shortcuts should Atlas use?
            </Dialog.Title>
            <p className="mt-1 px-2 text-[12px] leading-relaxed text-text-secondary">
              Pick the editor you are coming from and Atlas will match its muscle memory where it
              can.
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => choose(preset.id)}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-xl border border-white/10",
                  "bg-white/[0.06] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.12]",
                )}
              >
                <span>
                  <span className="block text-[12px] font-medium text-text-primary">
                    {preset.label}
                  </span>
                  <span className="block text-[10px] leading-snug text-text-tertiary">
                    {preset.description}
                  </span>
                </span>
                <PaletteChord preset={preset.id} />
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => choose()}
            className={cn(
              "mt-2 h-9 w-full rounded-lg border border-white/10 bg-white/10",
              "text-[12px] font-medium text-text-primary transition-colors hover:bg-white/[0.15]",
            )}
          >
            Decide later
          </button>

          <p className="mt-3 px-1 text-center text-[10px] leading-relaxed text-text-tertiary">
            You can change this any time, and rebind any single command, in Settings → Keybindings.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The command palette's chord under each preset — one concrete example does
 *  more to explain what a preset changes than another sentence would. */
function PaletteChord({ preset }: { preset: PresetId }) {
  const chord = PRESETS.find((p) => p.id === preset)?.bindings["command-palette"] ?? "mod+k";
  const combo = parseCombo(chord);
  if (!combo) return null;
  return <KbdCombo combo={formatCombo(combo)} className="shrink-0" />;
}
