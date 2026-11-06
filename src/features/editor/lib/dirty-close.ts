/**
 * Closing a file tab with unsaved edits. The edits live in the tab's editor
 * and its save session, both of which go when the tab unmounts, so a close
 * asks first: Save, Don't save, or Cancel. Escape and a click outside cancel,
 * and Save that fails keeps the tab open.
 *
 * Each open file tab registers how to save itself here (`registerFileSaver`),
 * by tab id, so the close path — which runs outside the tab's React tree —
 * can ask it to write without the panel mirroring its document anywhere.
 *
 * Once the last tab showing a file has closed, its buffer goes too: a cached
 * buffer left `dirty: true` would mark the next tab for that file unsaved
 * before it had been touched, and `ui_close` would refuse it for ever.
 */

import { choose } from "@/lib/confirm";
import { useEditorStore } from "../stores/editor-store";

/** Writes the tab's document; resolves whether it is now on disk. */
type FileSaver = () => Promise<boolean>;

const savers = new Map<string, FileSaver>();

/** Record how `tabId` saves; returns the matching unregister. An unregister
 *  only removes the saver it registered, so a stale cleanup cannot drop the
 *  one a remounted panel put there since. */
export function registerFileSaver(tabId: string, save: FileSaver): () => void {
  savers.set(tabId, save);
  return () => {
    if (savers.get(tabId) === save) savers.delete(tabId);
  };
}

interface FileTabLike {
  id: string;
  title: string;
  dirty?: boolean;
  data: Record<string, unknown>;
}

export function filePathOf(tab: { data: Record<string, unknown> }): string | undefined {
  return typeof tab.data.filePath === "string" ? tab.data.filePath : undefined;
}

/**
 * Whether `tab` may close now, asking about unsaved edits first. A clean tab
 * answers at once. "Save" writes through the tab's own panel and closes only
 * when the write landed; "Don't save" closes and drops the edits.
 */
export async function confirmCloseFileTab(tab: FileTabLike): Promise<boolean> {
  if (!tab.dirty) return true;
  const path = filePathOf(tab);
  const name = path?.split(/[\\/]/).pop() || tab.title;
  const choice = await choose({
    title: `Save changes to ${name}?`,
    body: "Your changes will be lost if you don't save them.",
    confirmLabel: "Save",
    alternateLabel: "Don't save",
    alternateDestructive: true,
  });
  if (choice === "cancel") return false;
  if (choice === "alternate") return true;
  const save = savers.get(tab.id);
  return save ? save() : false;
}

/**
 * After a file tab closed: drop the file's buffer when no remaining tab shows
 * it. `remaining` is every tab still open.
 */
export function releaseFileBuffer(
  path: string | undefined,
  remaining: ReadonlyArray<{ data: Record<string, unknown> }>,
): void {
  if (!path) return;
  if (remaining.some((t) => filePathOf(t) === path)) return;
  useEditorStore.getState().actions.closeBuffer(path);
}
