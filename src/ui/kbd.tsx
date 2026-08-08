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

/** Split a string like "⌘⇧F" or "⌘," into individual key glyphs. */
function splitKeys(combo: string): string[] {
  // Modifier glyphs are single chars; non-modifier "keys" may be multi-char names like "Enter".
  // We just split codepoints — works because all our combos are single-char per slot.
  return Array.from(combo);
}

/** Convenience: render a combo string ("⌘⇧F") as a KbdGroup of individual Kbds. */
function KbdCombo({ combo, className }: { combo: string; className?: string }) {
  return (
    <KbdGroup className={className}>
      {splitKeys(combo).map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

export { Kbd, KbdGroup, KbdCombo };
