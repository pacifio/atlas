import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[var(--z-overlay)]" />
        <Dialog.Content
          ref={contentRef}
          tabIndex={-1}
          onKeyDown={handleKey}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.focus();
          }}
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[var(--z-modal)] w-[700px] max-w-[92vw] rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/95 backdrop-blur-xl shadow-[var(--shadow-overlay)] p-5 outline-none"
        >
          <Dialog.Title className="text-[13px] font-semibold text-[var(--text-primary)] mb-0.5">
            Choose a layout
          </Dialog.Title>
          <p className="text-[11px] text-[var(--text-tertiary)] mb-4">
            Rearranges panels and tabs into a ready-made workspace.
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
                    ? "border-[var(--accent-primary)] bg-[var(--bg-active)]"
                    : "border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]",
                )}
              >
                <LayoutThumbnail template={t} />
                <div className="mt-2 text-[12px] font-medium text-[var(--text-primary)]">
                  {t.name}
                </div>
                <div className="text-[10px] text-[var(--text-tertiary)] leading-snug line-clamp-2">
                  {t.description}
                </div>
              </button>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-center gap-3 text-[10px] text-[var(--text-tertiary)]">
            <Hint k="↑ ↓ ← →" label="navigate" />
            <Hint k="⏎" label="apply" />
            <Hint k="esc" label="close" />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-base)] border border-[var(--border-default)] font-mono text-[9px] text-[var(--text-secondary)]">
        {k}
      </kbd>
      {label}
    </span>
  );
}
