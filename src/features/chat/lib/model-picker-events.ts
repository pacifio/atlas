// The window event that opens (or closes) a composer's model picker from
// outside it: the chat panel turns `chat.toggleModelPicker` (⌘⇧M) into one,
// addressed to its tab, and that tab's composer answers it.

/** Toggles the model picker of the composer in `detail.tabId`. */
export const OPEN_MODEL_PICKER_EVENT = "atlas:composer-open-model";

interface OpenModelPickerDetail {
  tabId?: string;
}

/** Ask the composer in `tabId` to toggle its model picker. */
export function requestModelPicker(tabId: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenModelPickerDetail>(OPEN_MODEL_PICKER_EVENT, { detail: { tabId } }),
  );
}

/** Run `onRequest` whenever the picker of `tabId` is asked for; requests
 *  addressed to another tab are ignored. Returns the unsubscribe. */
export function onModelPickerRequest(tabId: string, onRequest: () => void): () => void {
  const listener = (e: Event) => {
    if ((e as CustomEvent<OpenModelPickerDetail>).detail?.tabId !== tabId) return;
    onRequest();
  };
  window.addEventListener(OPEN_MODEL_PICKER_EVENT, listener);
  return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, listener);
}
