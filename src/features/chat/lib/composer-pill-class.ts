// The composer footer pills' class strings. Pure (no React, no `window`), so a
// view can draw a pill without importing `composer-dropup.tsx`, which
// dispatches window events.

import { cn } from "@/lib/utils";

/** The pill trigger's class string, so every footer pill reads as one set. */
export function composerPillClass(open: boolean, opts: { disabled?: boolean } = {}): string {
  return cn(
    "flex h-6.5 items-center rounded-full border px-1.5 text-2xs font-medium leading-none transition-colors",
    open
      ? "border-border-strong bg-element-selected text-foreground"
      : "border-border bg-card text-secondary-foreground",
    opts.disabled
      ? "cursor-default"
      : "cursor-pointer hover:bg-element-hover hover:text-foreground",
  );
}

/**
 * A footer pill's text label. As the composer narrows, labels give way to
 * their icons instead of wrapping onto a second line or pushing the right-hand
 * pills out past the edge. The composer shell is the `@container`; each pill's
 * `title` still names it when only the icon shows.
 *  - `"early"`: the icon carries the meaning on its own (usage ring, options
 *    sliders, memory index), so these go first.
 *  - `"late"`: agent and mode, which only an icon cannot fully identify.
 *  - omitted: always shown (the model, which truncates instead).
 */
export function composerPillLabelClass(collapse?: "early" | "late"): string {
  return cn(
    "ml-1.5 whitespace-nowrap",
    collapse === "early" && "hidden @[640px]:inline",
    collapse === "late" && "hidden @[460px]:inline",
  );
}
