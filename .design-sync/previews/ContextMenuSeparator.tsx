import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "atlas";

/**
 * A hairline rule that partitions a menu into groups. Uses the same
 * `--border-default` token as the panel edge, inset to the panel padding.
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

export const BetweenGroups = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Two groups
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename…</ContextMenuItem>
          <ContextMenuItem>Duplicate</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};

export const MultipleGroups = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 220 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Three groups
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open to the side</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem>Stage hunk</ContextMenuItem>
          <ContextMenuItem>Discard changes</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
