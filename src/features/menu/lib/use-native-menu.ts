import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isMac } from "@/lib/platform";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import { toMenuAccelerator } from "@/features/keybindings/lib/native-accelerator";
import { setMenuAccelerators } from "./menu-api";
import { MENU_EVENT, menuActionIds } from "./menu-model";
import { runMenuItem } from "./run-menu-item";

const ACTION_IDS = menuActionIds();

/**
 * The renderer half of the native macOS menu (`src-tauri/src/menu.rs`): run
 * whatever item was clicked, and keep every item's accelerator on the user's
 * current chord for it. A no-op off macOS, where the titlebar draws the menu.
 */
export function useNativeMenu(): void {
  useEffect(() => {
    if (!isMac) return;
    const unlisten = listen<string>(MENU_EVENT, (event) => {
      if (!runMenuItem(event.payload)) console.warn("menu item did nothing:", event.payload);
    });
    return () => void unlisten.then((off) => off());
  }, []);

  // Select one string, not the combos: it is stable across every store update
  // that rebuilds binding objects without changing a chord, so this costs one
  // IPC call per actual rebind. A menu item carries one chord; the first is
  // the one Settings shows.
  const loaded = useKeybindingsStore.use.loaded();
  const accelerators = useKeybindingsStore((s) =>
    JSON.stringify(
      Object.fromEntries(
        ACTION_IDS.map((id) => {
          const first = s.resolved.byAction.get(id)?.[0];
          return [id, first ? toMenuAccelerator(first.combo) : null];
        }),
      ),
    ),
  );

  useEffect(() => {
    // Before load the bindings are not the user's yet; don't flap the menu.
    if (!isMac || !loaded) return;
    setMenuAccelerators(JSON.parse(accelerators) as Record<string, string | null>).catch((e) =>
      console.warn("could not update the menu's shortcuts:", e),
    );
  }, [loaded, accelerators]);
}
