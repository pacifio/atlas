import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toNativeAccelerator } from "../lib/native-accelerator";
import { primaryCombo } from "../lib/resolve";
import { useKeybindingsStore } from "../stores/keybindings-store";

/**
 * Keep the native Window ▸ Close Tab item on whatever "Close Tab" is bound to.
 *
 * That menu item is the only way the chord works while the embedded browser —
 * a separate native webview — has focus, so it is the one binding that has to
 * exist in two places. See `src-tauri/src/menu.rs`.
 */
export function useNativeCloseTabAccelerator(): void {
  // Selecting the accelerator string rather than the combo keeps this to one
  // IPC call per actual rebinding: the string is stable across every store
  // update that rebuilds the binding objects without changing the chord.
  const accelerator = useKeybindingsStore((s) => {
    // The first chord: a menu item can only carry one, and the first is the
    // one Settings shows for the command.
    const combo = primaryCombo(s.keymap.bindings.find((b) => b.action.id === "close-tab"));
    return combo ? toNativeAccelerator(combo) : null;
  });

  useEffect(() => {
    void invoke("set_close_tab_accelerator", { accelerator }).catch((e) => {
      console.warn("could not update the native Close Tab accelerator:", e);
    });
  }, [accelerator]);
}
