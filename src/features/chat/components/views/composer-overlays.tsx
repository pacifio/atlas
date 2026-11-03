// The composer's two overlays: the GitHub-clone sync lock, and the
// drop-to-reference scrim portalled into the drop zone. Props-only.

import { createPortal } from "react-dom";
import { AtSign, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function ComposerSyncOverlay({ repo }: { repo: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--background)]/40 backdrop-blur-[1px]">
      <span className="flex items-center gap-2 rounded-full bg-[var(--card)] px-3 py-1 text-xs font-medium text-[var(--secondary-foreground)] shadow">
        <Loader2 size={12} className="animate-spin" />
        Syncing {repo}…
      </span>
    </div>
  );
}

export function ComposerDropOverlay({ zone, active }: { zone: HTMLElement; active: boolean }) {
  return createPortal(
    // In with no transition: this is direct feedback to the pointer
    // crossing into the zone, and any fade reads as lag behind the
    // hand. Out over `duration-instant`, so it doesn't vanish in the
    // same frame the dropped attachment appears. Always mounted
    // (toggled by `data-active`) so the exit can transition at all.
    // Opacity only; nothing travels, so reduced motion needs no variant.
    // `z-40` clears the composer's own `z-30` in the same stacking
    // context; a named layer would escape the column and cover toasts.
    <div
      aria-hidden="true"
      data-active={active}
      className={cn(
        "pointer-events-none absolute inset-2 z-40 flex items-center justify-center",
        // The scrim dims the thread behind: the label must read as the one
        // live layer, not float among the welcome tiles.
        "rounded-xl border border-dashed border-[var(--primary)] bg-[var(--background)]/80",
        "opacity-0 transition-opacity duration-instant ease-out-strong",
        "data-[active=true]:opacity-100 data-[active=true]:duration-0",
      )}
    >
      <div className="flex flex-col items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 shadow-md">
        <AtSign size={16} className="text-[var(--primary)]" />
        <span className="text-sm font-medium text-[var(--foreground)]">Drop to reference</span>
        {/* Says what will happen, because the two gestures now differ:
            a drop writes a chip into the sentence, the "+" menu
            attaches. */}
        <span className="text-xs text-[var(--muted-foreground)]">
          Added as an @mention in your message
        </span>
      </div>
    </div>,
    zone,
  );
}
