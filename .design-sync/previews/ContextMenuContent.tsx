import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from "atlas";

/**
 * The menu panel: pure-black fill, hairline border and a lifted shadow,
 * portalled above everything at z-9999.
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

export const ShortMenu = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Two actions
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename…</ContextMenuItem>
          <ContextMenuItem>Duplicate</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};

export const GroupedMenu = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 240 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Grouped actions
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>File</ContextMenuLabel>
          <ContextMenuItem>Open to the side</ContextMenuItem>
          <ContextMenuItem>Reveal in Finder</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuLabel>Git</ContextMenuLabel>
          <ContextMenuItem>Stage hunk</ContextMenuItem>
          <ContextMenuItem>Discard changes</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
