import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from "atlas";

/**
 * A toggleable row. Checked state draws a leading check glyph in the gutter;
 * unchecked rows keep the same inset so labels stay aligned.
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

export const CheckedAndUnchecked = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            View options
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem checked>Show hidden files</ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem>Follow symlinks</ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem checked>Group by folder</ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};

export const InAGroup = () => {
  const ref = useOpenAt(60, 13);
  return (
    <div style={{ height: 230 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={ref} style={targetStyle}>
            Panel toggles
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>Panels</ContextMenuLabel>
          <ContextMenuCheckboxItem checked>File tree</ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem checked>Source control</ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem>Timeline</ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem disabled>Spaces (no canvas)</ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
