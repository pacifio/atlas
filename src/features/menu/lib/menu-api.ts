import { invoke } from "@tauri-apps/api/core";

/** Point the native menu's items at these chords (macOS); `null` leaves an
 *  item without one. Ids the menu doesn't carry are ignored. */
export function setMenuAccelerators(accelerators: Record<string, string | null>): Promise<void> {
  return invoke("menu_set_accelerators", { accelerators });
}
