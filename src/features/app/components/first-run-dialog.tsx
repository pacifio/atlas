import { useState } from "react";
import { AtlasIcon } from "@/components/atlas-icon";
import { StepDots } from "@/components/step-dots";
import { KeymapStep, type KeymapAnswer } from "@/features/keybindings/components/keymap-step";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import { reportFirstRunComplete } from "@/features/tips/lib/tips-api";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@tryatlas/design";

/**
 * First run (CONTEXT.md): what Atlas is, then which editor's shortcuts to
 * use. Kept to two steps on purpose; everything else is taught by Tips, at
 * the moment the user meets it.
 *
 * Shown while there is no keybindings.json — the keymap step's answer writes
 * it, so the file is the "First run is done" record, and someone upgrading
 * (who has one) never sees this. Escape at either step finishes First run
 * with the keymap left as Atlas's own, as "Decide later" does.
 *
 * DRAFT COPY: the product card's wording is for the user to rewrite.
 */
export function FirstRunDialog() {
  const open = useKeybindingsStore.use.firstRun();
  const { completeOnboarding } = useKeybindingsStore.use.actions();
  const [step, setStep] = useState<"product" | "keymap">("product");
  const report = (answer: KeymapAnswer) => void reportFirstRunComplete(answer).catch(() => {});

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        report("later");
        void completeOnboarding(null);
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-md">
        {step === "product" ? (
          <>
            <DialogHeader>
              <AtlasIcon size={28} />
              <DialogTitle>Welcome to Atlas</DialogTitle>
              <DialogDescription>
                Run your coding agents side by side. Atlas records every session and links it to the
                commits it produced, so you always know which prompt shipped which line.
              </DialogDescription>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">
              Short tips appear the first time you meet something new. Turn them off in Settings →
              General.
            </p>
            <DialogFooter className="items-center sm:justify-between">
              <StepDots count={2} step={0} />
              <Button size="sm" onClick={() => setStep("keymap")}>
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <KeymapStep onChosen={report} />
        )}
      </DialogContent>
    </Dialog>
  );
}
