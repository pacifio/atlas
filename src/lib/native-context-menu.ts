import { useEffect } from "react";
import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { copyText } from "./clipboard";

/**
 * The right-click menu anywhere nothing more specific claimed it: the
 * platform's own edit menu, popped by the shell.
 *
 * Native, not a React popup, for the selection's sake. A DOM menu takes focus
 * and a pointer press, and either one clears the selection the user
 * right-clicked to act on. The shell's menu touches neither, and its edit
 * items run the webview's own `copy:` / `paste:` actions, which the platform
 * enables against the live selection and the focused field.
 *
 * A row, a tab or a canvas with its own menu prevents the event first (Base
 * UI's `ContextMenu.Trigger` does), and this stands down for it.
 */
export function useNativeContextMenu() {
  useEffect(() => {
    // Outside the shell (`bun run dev` in a browser) the browser's own menu
    // is the native one.
    if (!(globalThis as { isTauri?: boolean }).isTauri) return;
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      void showEditMenu(linkAt(event.target));
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}

/** An http(s) link under the pointer: the one thing worth more than editing. */
function linkAt(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : null;
  const href = element?.closest("a[href]")?.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function showEditMenu(link: string | null) {
  const items: (MenuItemOptions | PredefinedMenuItemOptions)[] = [];
  if (link) {
    items.push({ text: "Copy Link", action: () => void copyText(link) }, { item: "Separator" });
  }
  items.push({ item: "Cut" }, { item: "Copy" }, { item: "Paste" }, { item: "SelectAll" });
  const menu = await Menu.new({ items });
  await menu.popup();
}
