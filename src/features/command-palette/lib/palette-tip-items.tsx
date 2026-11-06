// The palette's two tip rows: "Show tip…" (a submenu of every tip the user may
// bring back, each shown now — or as soon as its feature is on screen) and
// "Replay all tips", the same reset Settings → General → Tips runs.

import { Lightbulb, RotateCcw } from "lucide-react";
import { REPLAYABLE_TIPS } from "@/features/tips/lib/tip-registry";
import { useTipsStore } from "@/features/tips/stores/tips-store";
import { replayAllTips } from "@/features/tips/lib/replay-tips";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./command-palette-logic";
import { Icon } from "@tryatlas/design";

export function paletteTipItems(): {
  showTipItem: CommandPaletteSubmenuItem;
  replayTipsItem: CommandPaletteActionItem;
} {
  const { showByName } = useTipsStore.getState().actions;

  const showTipItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:show-tip",
    searchTerms: ["show tip", "tips", "help", "tutorial", "onboarding", "how do i"],
    title: "Show tip…",
    icon: <Icon icon={Lightbulb} size="lg" />,
    placeholder: "Search tips…",
    groups: [
      {
        value: "tips",
        label: "Show tip",
        items: REPLAYABLE_TIPS.map((tip) => ({
          kind: "action" as const,
          value: `tip:${tip.id}`,
          title: tip.steps[0]?.title ?? tip.id,
          searchTerms: tip.steps.flatMap((s) => [s.title, s.body]),
          icon: <Icon icon={Lightbulb} size="lg" />,
          run: () => showByName(tip.id),
        })),
      },
    ],
  };

  const replayTipsItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:replay-tips",
    searchTerms: ["replay all tips", "reset tips", "tips", "onboarding"],
    title: "Replay all tips",
    icon: <Icon icon={RotateCcw} size="lg" />,
    run: replayAllTips,
  };

  return { showTipItem, replayTipsItem };
}
