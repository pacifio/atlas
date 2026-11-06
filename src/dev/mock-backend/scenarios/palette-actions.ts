// Console triggers for the palettes and overlays, so a review (or a script
// that cannot press ⌘ chords) can open them as `__atlasMock.actions.<name>()`.
// They go through `runAction`, the same path a keybinding and `ui_command`
// take, so what opens is exactly what the shortcut opens.

import { runAction } from "@/features/keybindings/lib/action-registry";
import { useHintStore } from "@/features/hint-nav/stores/hint-store";

export const paletteActions = {
  openCommandPalette: () => void runAction("nav.commandPalette"),
  openNewTabPalette: () => void runAction("nav.newTabPalette"),
  openSearch: () => void runAction("nav.search"),
  openFilePicker: () => void runAction("nav.filePicker"),
  openSettings: () => void runAction("app.settings"),
  openHints: () => useHintStore.getState().actions.open(),
};
