import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { LAYOUT_TEMPLATES, type LayoutTemplate } from "../templates";
import { LayoutThumbnail } from "./layout-thumbnail";

const COLS = 3;

/** Windows-task-view-style layout switcher (⌘⌥L): a grid of layout thumbnails
 *  navigated by arrow keys or mouse; Enter / click applies. */
export function LayoutSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  // Reset selection each time it opens.
  useEffect(() => {
    if (open) setSelected(0);
  }, [open]);

  const apply = (t: LayoutTemplate) => {
    useLayoutStore.getState().actions.applyLayoutTemplate(t);
    onOpenChange(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    const n = LAYOUT_TEMPLATES.length;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setSelected((i) => Math.min(n - 1, i + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(n - 1, i + COLS));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - COLS));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = LAYOUT_TEMPLATES[selected];
      if (t) apply(t);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 scrim backdrop-blur-sm z-overlay" />
        <Dialog.Popup
          ref={contentRef}
          tabIndex={-1}
          onKeyDown={handleKey}
          // Base UI's initialFocus replaces Radix's onOpenAutoFocus +
          // preventDefault + focus(): hand it the element to land on.
          initialFocus={contentRef}
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-modal w-[700px] max-w-[92vw] rounded-2xl border border-[var(--border)] bg-[var(--card)]/95 backdrop-blur-xl shadow-md p-5 outline-none"
        >
          <Dialog.Title className="text-base font-semibold text-[var(--foreground)] mb-0.5">
            Choose a layout
          </Dialog.Title>
          <p className="text-xs text-[var(--muted-foreground)] mb-4">
            Rearranges panels and tabs into a ready-made project.
          </p>

          <div className="grid grid-cols-3 gap-3">
            {LAYOUT_TEMPLATES.map((t, i) => (
              <button
                key={t.id}
                onClick={() => apply(t)}
                onMouseEnter={() => setSelected(i)}
                className={cn(
                  "text-left rounded-xl border p-2.5 transition-colors outline-none",
                  i === selected
                    ? "border-[var(--primary)] bg-element-active"
                    : "border-[var(--border)] bg-[var(--card)] hover:border-border-strong",
                )}
              >
                <LayoutThumbnail template={t} />
                <div className="mt-2 text-sm font-medium text-[var(--foreground)]">{t.name}</div>
                <div className="text-2xs text-[var(--muted-foreground)] leading-snug line-clamp-2">
                  {t.description}
                </div>
              </button>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-center gap-3 text-2xs text-[var(--muted-foreground)]">
            <Hint k="↑ ↓ ← →" label="navigate" />
            <Hint k="⏎" label="apply" />
            <Hint k="esc" label="close" />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border)] font-mono text-3xs text-[var(--secondary-foreground)]">
        {k}
      </kbd>
      {label}
    </span>
  );
}
