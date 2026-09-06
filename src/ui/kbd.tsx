import * as React from "react";
import { cn } from "@/lib/utils";
import { splitGlyphCombo } from "@/features/keybindings/lib/combo";

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

/** Render a list of keycaps (["⌘", "⇧", "B"]) — the form `displayKeys` produces. */
function KbdKeys({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <KbdGroup className={className}>
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

/** Convenience: render a glyph string ("⌘⇧F", "⌥Space") as a KbdGroup. Every
 *  modifier glyph is its own cap; the remainder ("F", "Space") is one cap. */
function KbdCombo({ combo, className }: { combo: string; className?: string }) {
  return <KbdKeys keys={splitGlyphCombo(combo)} className={className} />;
}

export { Kbd, KbdGroup, KbdKeys, KbdCombo };
