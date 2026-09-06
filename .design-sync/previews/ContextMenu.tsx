import { useEffect, useRef } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuCheckboxItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "atlas";

/**
 * A context menu only exists once it has been opened at a pointer position —
 * that is where Radix anchors the popper. Previews therefore dispatch a real
 * `contextmenu` event on the trigger so the card shows the true open surface
 * rather than an unanchored, hidden one.
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

/** The file-tree row menu — the surface this primitive was built for. */
export const FileTreeMenu = () => {
  const ref = useOpenAt(60, 14);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            className="flex h-7 w-[240px] items-center rounded px-2 text-[11.5px] text-[var(--text-secondary)] bg-[var(--bg-hover)]"
          >
            src/features/chat/chat-panel.tsx
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>chat-panel.tsx</ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuItem>
            Open to the side
            <ContextMenuShortcut>⌘\</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem>
            Reveal in Finder
            <ContextMenuShortcut>⌥⌘R</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem>Copy relative path</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};

/** Checkable options plus a submenu. */
export const WithChecksAndSubmenu = () => {
  const ref = useOpenAt(60, 14);
  return (
    <div style={{ height: 200 }}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            className="flex h-7 w-[240px] items-center rounded px-2 text-[11.5px] text-[var(--text-secondary)] bg-[var(--bg-hover)]"
          >
            Workspace rail
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem checked>Show hidden files</ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem>Follow symlinks</ContextMenuCheckboxItem>
          <ContextMenuSeparator />
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
