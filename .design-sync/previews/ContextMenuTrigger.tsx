import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "atlas";

/**
 * The right-click surface. `asChild` merges the trigger onto your own
 * element — pass a plain element, never a wrapper component, or the merged
 * handlers are silently dropped and the menu never opens.
 *
 * A context menu is anchored where it was opened, so previews dispatch a real
 * `contextmenu` event at the trigger — an unopened menu has no position and
 * renders invisible.
 */
function useOpenAt(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: r.left + x,
        clientY: r.top + y,
      }),
    );
  }, [x, y]);
  return ref;
}

const targetStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 26,
  width: 240,
  borderRadius: 4,
  padding: "0 8px",
  fontSize: 11.5,
  color: "var(--text-secondary)",
  background: "var(--bg-hover)",
};

export const OnAFileRow = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            src/features/chat/chat-panel.tsx
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open to the side</ContextMenuItem>
          <ContextMenuItem>Copy relative path</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};

export const OnAPanelSurface = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Workspace rail
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>New workspace…</ContextMenuItem>
          <ContextMenuItem>Close others</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
