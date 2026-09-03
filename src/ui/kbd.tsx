import * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-[18px] w-fit min-w-[18px] items-center justify-center gap-1 rounded-[4px]",
        "bg-bg-elevated border border-border-default px-1.5 font-sans text-[10px] leading-none font-medium text-text-tertiary select-none",
        "[&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

/**
 * Render a chord as one `Kbd` per key.
 *
 * Takes either the parts (`["Ctrl", "Shift", "K"]`, what `formatCombo` returns)
 * or a glyph string (`"⌘⇧F"`), which is split by codepoint. The string form
 * only works where every key is a single glyph, which is why anything driven by
 * the keymap passes parts instead.
 */
function KbdCombo({ combo, className }: { combo: string | string[]; className?: string }) {
  const keys = Array.isArray(combo) ? combo : Array.from(combo);
  return (
    <KbdGroup className={className}>
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

export { Kbd, KbdGroup, KbdCombo };
