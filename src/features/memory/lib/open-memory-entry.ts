import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useMemoryStore } from "../stores/memory-store";

/** Open the entry in Memory ▸ Memories, chosen. The Memory tab is
 *  one per column, so this focuses the open one or opens it. */
export function openMemoryEntry(id: number): void {
  useMemoryStore.getState().actions.focusEntry(id);
  useLayoutStore.getState().actions.addTab({
    id: "memory",
    type: "memory",
    title: "Memory",
    closable: true,
    dirty: false,
    data: {},
  });
}
