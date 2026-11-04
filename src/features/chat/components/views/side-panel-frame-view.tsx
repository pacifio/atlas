import { useEffect, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { Hint, Icon, IconButton } from "@tryatlas/design";

/**
 * The overlay the Plans and Bash calls panels slide in on: a soft scrim over
 * the session (a click on it closes), and a panel anchored to the pane's
 * right edge with a header and a left-edge resize handle.
 *
 * Pane-local on purpose — `absolute`, inside the session pane, not the
 * package `Sheet` (portaled, `fixed`): two session panes can sit side by side,
 * and each one's panel belongs to its own pane.
 *
 * The width is the container's; the view does not clamp it (the layout store
 * does). Esc closes, as the panel is a plain div rather than a dialog.
 */
export function SidePanelFrameView({
  panel,
  icon,
  title,
  count,
  width,
  top,
  onWidthChange,
  onClose,
  closeLabel,
  children,
}: {
  panel: "plans" | "bash-history";
  icon: LucideIcon;
  title: string;
  count: number;
  width: number;
  /** Below the session column's floating window bar (`usePaneTopInset`). */
  top: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Left-edge resize: the panel is anchored right, so dragging left widens it.
  const startX = useRef<number | null>(null);
  const startWidth = useRef(0);
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    startWidth.current = width;
    const onMove = (ev: MouseEvent) => {
      if (startX.current === null) return;
      onWidthChange(startWidth.current + (startX.current - ev.clientX));
    };
    const onUp = () => {
      startX.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      {/* Scrim — click outside the panel to dismiss. Subtle so the session
          stays readable underneath the overlay. */}
      <div
        className="absolute inset-0 z-20 scrim-soft animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        data-panel={panel}
        style={{ width, top }}
        className="absolute right-0 bottom-0 z-30 flex flex-col border-l border-border bg-sidebar shadow-md animate-slide-in-right"
      >
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 -left-px z-10 h-full w-px cursor-col-resize bg-border transition-colors hover:bg-primary"
          title="Drag to resize"
        />

        <div className="flex h-[32px] shrink-0 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-1.5">
            <Icon icon={icon} size="sm" className="text-muted-foreground" />
            <span className="text-xs font-medium text-secondary-foreground">{title}</span>
            <span className="text-2xs text-muted-foreground">· {count}</span>
          </div>
          <Hint label={closeLabel}>
            <IconButton
              variant="ghost"
              size="xs"
              icon={ChevronRight}
              label={closeLabel}
              onClick={onClose}
            />
          </Hint>
        </div>

        {children}
      </div>
    </>
  );
}
