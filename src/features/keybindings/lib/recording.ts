import { useKeybindingsStore } from "../stores/keybindings-store";

/**
 * True while Settings → Keybindings is taking a chord (a row's recorder, or
 * the search field in press-a-shortcut mode).
 *
 * For window key listeners outside the keybindings feature that answer a key
 * on their own, like a pending permission prompt in a session tab that stays
 * mounted behind Settings: a key pressed into the recorder is not meant for
 * them. The app's hotkey dispatchers already check the same flag.
 */
export function isRecordingShortcut(): boolean {
  return useKeybindingsStore.getState().recording;
}
