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
 * The nesting wrapper: it pairs a `ContextMenuSubTrigger` row with the
 * `ContextMenuSubContent` panel that flies out beside it.
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

export const OneSubmenu = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            With a submenu
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open</ContextMenuItem>
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

export const TwoSubmenus = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 230 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Two submenus
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Open with</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Atlas editor</ContextMenuItem>
              <ContextMenuItem>System default</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Copy as</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Relative path</ContextMenuItem>
              <ContextMenuItem>Absolute path</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
