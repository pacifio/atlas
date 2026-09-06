import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from "atlas";

/**
 * The flyout panel of a submenu. Same fill, border and shadow as the root
 * panel, positioned beside its trigger row.
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

export const ShortFlyout = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Short flyout
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub open>
            <ContextMenuSubTrigger>Open with</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Atlas editor</ContextMenuItem>
              <ContextMenuItem>System default</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};

export const GroupedFlyout = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 220 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Grouped flyout
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub open>
            <ContextMenuSubTrigger>Copy as</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Relative path</ContextMenuItem>
              <ContextMenuItem>Absolute path</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem>Permalink</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
