import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Kbd,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { LayoutTemplate } from "../../templates";
import { LayoutThumbnail } from "../layout-thumbnail";

/** Tiles per row, which is how far Up and Down move. */
const COLS = 3;

/**
 * The layout switcher (⌘⌥L): a grid of layout thumbnails, navigated by the
 * arrow keys or the pointer; Enter or a click applies. Escape is the dialog's
 * own close. The selection starts on the first tile every time it opens.
 */
export function LayoutSwitcherView({
  open,
  onOpenChange,
  templates,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: readonly LayoutTemplate[];
  onApply: (template: LayoutTemplate) => void;
}) {
  const [selected, setSelected] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setSelected(0);
  }, [open]);

  const handleKey = (e: React.KeyboardEvent) => {
    const last = templates.length - 1;
    const move = (to: (i: number) => number) => {
      e.preventDefault();
      setSelected((i) => Math.max(0, Math.min(last, to(i))));
    };
    if (e.key === "ArrowRight") move((i) => i + 1);
    else if (e.key === "ArrowLeft") move((i) => i - 1);
    else if (e.key === "ArrowDown") move((i) => i + COLS);
    else if (e.key === "ArrowUp") move((i) => i - COLS);
    else if (e.key === "Enter") {
      e.preventDefault();
      const t = templates[selected];
      if (t) onApply(t);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        onKeyDown={handleKey}
        // Focus lands on the grid itself, so the arrow keys work at once.
        initialFocus={contentRef}
        showCloseButton={false}
        className="max-w-[min(700px,92vw)] gap-4 p-5"
      >
        <DialogHeader>
          <DialogTitle>Choose a layout</DialogTitle>
          <DialogDescription>
            Rearranges panels and tabs into a ready-made project.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3">
          {templates.map((t, i) => (
            <button
              key={t.id}
              type="button"
              data-selected={i === selected || undefined}
              onClick={() => onApply(t)}
              onMouseEnter={() => setSelected(i)}
              className={cn(
                "rounded-xl border p-2.5 text-left outline-none transition-colors",
                i === selected
                  ? "border-primary bg-element-active"
                  : "border-border bg-card hover:border-border-strong",
              )}
            >
              <LayoutThumbnail template={t} />
              <div className="mt-2 text-sm font-medium text-foreground">{t.name}</div>
              <div className="text-2xs leading-snug text-muted-foreground line-clamp-2">
                {t.description}
              </div>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-center gap-3 text-2xs text-muted-foreground">
          <KeyHint k="↑ ↓ ← →" label="navigate" />
          <KeyHint k="⏎" label="apply" />
          <KeyHint k="esc" label="close" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <Kbd>{k}</Kbd>
      {label}
    </span>
  );
}
