import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "atlas";

/**
 * A non-interactive section heading inside the menu — used to name a group
 * of actions, or to title the menu after the row it opened on.
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

export const AsMenuTitle = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            chat-panel.tsx
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>chat-panel.tsx</ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuItem>Open to the side</ContextMenuItem>
          <ContextMenuItem>Copy relative path</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};

export const AsSectionHeadings = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 220 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Grouped menu
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>File</ContextMenuLabel>
          <ContextMenuItem>Rename…</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuLabel>Git</ContextMenuLabel>
          <ContextMenuItem>Stage hunk</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
