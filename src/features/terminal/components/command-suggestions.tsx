// Terminal command/path autocomplete dropdown. Floats ABOVE the command
// textarea, anchored to its bounding rect (portal + fixed) — no caret tracking.
// Purely presentational + controlled: the parent (command-input.tsx) owns the
// item list and the active index (which follows Tab-cycling). It never takes
// DOM focus, so typing in the textarea continues uninterrupted.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, FileText, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Suggestion {
  /** The completion text (entry name, or command name). */
  name: string;
  kind: "command" | "dir" | "file";
}

interface Props {
  open: boolean;
  items: Suggestion[];
  activeIndex: number;
  /** The command textarea — used only for its bounding rect. */
  anchorEl: HTMLElement | null;
  onSelect: (s: Suggestion) => void;
  onClose: () => void;
}

const GAP = 6;
const MIN_WIDTH = 260;
const MAX_WIDTH = 460;

export function CommandSuggestions({
  open,
  items,
  activeIndex,
  anchorEl,
  onSelect,
  onClose,
}: Props) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const activeRowRef = useRef<HTMLButtonElement>(null);

  // Keep the highlighted row visible as Tab cycles past the viewport.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Dismiss on click outside the picker and outside the terminal input.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".atlas-cmd-suggest")) return;
      if (anchorEl && anchorEl.contains(t)) return;
      onCloseRef.current();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, anchorEl]);

  // The anchor is measured when the picker OPENS (and on window resize), not
  // per render: it re-renders on every keystroke and Tab, and each
  // `getBoundingClientRect` in render was a forced layout of whatever the
  // terminal had dirtied — a streaming block list, during a build or a push.
  const [rect, setRect] = useState<DOMRect | null>(null);
  const shown = open && items.length > 0 && !!anchorEl;
  useLayoutEffect(() => {
    if (!shown || !anchorEl) {
      setRect(null);
      return;
    }
    const measure = () => setRect(anchorEl.getBoundingClientRect());
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [shown, anchorEl]);

  if (!shown || !rect) return null;

  const vw = window.innerWidth;
  const width = Math.max(MIN_WIDTH, Math.min(rect.width, MAX_WIDTH));
  const left = Math.max(8, Math.min(rect.left, vw - width - 8));
  const bottom = Math.max(8, window.innerHeight - rect.top + GAP);

  return createPortal(
    <div
      className={cn(
        "atlas-cmd-suggest",
        "rounded-md overflow-hidden flex flex-col",
        "bg-popover border border-border",
        "shadow-md z-popover",
      )}
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, bottom, width, maxHeight: 280 }}
    >
      <div className="flex-1 overflow-y-auto py-1 hide-scrollbar">
        {items.map((s, i) => {
          const isActive = i === activeIndex;
          const Icon = s.kind === "dir" ? Folder : s.kind === "command" ? TerminalSquare : FileText;
          return (
            <button
              key={`${s.kind}:${s.name}`}
              ref={isActive ? activeRowRef : undefined}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(s);
              }}
              className={cn(
                "w-full text-left px-2.5 h-control-sm flex items-center gap-2 text-sm font-mono",
                isActive
                  ? "bg-element-selected text-foreground"
                  : "text-secondary-foreground hover:bg-element-hover",
              )}
            >
              <Icon
                size={11}
                className={cn(
                  "shrink-0",
                  s.kind === "dir" ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="truncate">
                {s.name}
                {s.kind === "dir" ? "/" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <div className="border-t border-border px-2.5 h-control-sm flex items-center justify-end gap-2 text-3xs uppercase tracking-wider text-muted-foreground shrink-0">
        <span>⇥ ↑↓ cycle · ↵ run · ⎋</span>
      </div>
    </div>,
    document.body,
  );
}
