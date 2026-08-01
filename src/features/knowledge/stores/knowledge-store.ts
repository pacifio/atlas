import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { logEvent } from "@/features/log/lib/log";

interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  file_path: string;
  updated_at: string;
}

interface KnowledgeState {
  entries: KnowledgeEntry[];
  activeEntryId: string | null;
  editContent: string;
  loading: boolean;
  /** A note the user asked to open from OUTSIDE the KB panel (e.g. the
   *  left-panel quick list). The panel consumes this on mount/change and
   *  routes it through its dirty-save-aware select, so opening a specific
   *  note works even when the (lazy) panel isn't mounted yet. */
  pendingOpenId: string | null;
  actions: {
    loadEntries: (projectPath: string) => Promise<void>;
    selectEntry: (id: string) => void;
    /** Request the panel open a specific note (from the left-panel list). */
    requestOpen: (id: string) => void;
    /** Panel clears the pending request after handling it. */
    consumePendingOpen: () => void;
    setEditContent: (content: string) => void;
    /** Save an explicit (workspace path, note id, content) triple. The caller
     *  captures all three atomically so a workspace switch can never cross the
     *  content of one workspace into another's file. */
    saveEntry: (
      projectPath: string,
      id: string,
      content: string,
    ) => Promise<void>;
    createEntry: (projectPath: string) => Promise<void>;
    deleteEntry: (projectPath: string, id: string) => Promise<void>;
    createDir: (projectPath: string, dirName: string) => Promise<void>;
  };
}

export const useKnowledgeStore = createSelectors(
  create<KnowledgeState>()((set, get) => ({
    entries: [],
    activeEntryId: null,
    editContent: "",
    loading: false,
    pendingOpenId: null,
    actions: {
      loadEntries: async (projectPath) => {
        try {
          const newEntries = await invoke<KnowledgeEntry[]>("list_knowledge", {
            projectPath,
          });
          const current = get();

          // Skip update if entries haven't changed (prevent unnecessary re-renders)
          const unchanged =
            current.entries.length === newEntries.length &&
            current.entries.every(
              (e, i) =>
                e.id === newEntries[i]?.id &&
                e.updated_at === newEntries[i]?.updated_at,
            );
          if (unchanged && !current.loading) return;

          const activeStillExists = newEntries.find(
            (e) => e.id === current.activeEntryId,
          );
          set({
            entries: newEntries,
            loading: false,
            activeEntryId: activeStillExists
              ? current.activeEntryId
              : (newEntries[0]?.id ?? null),
            editContent:
              activeStillExists?.content ?? newEntries[0]?.content ?? "",
          });
          // Mirror the new entry set into the Rust mention cache so
          // the @-picker doesn't have to ship the full knowledge
          // array on every keystroke. Lazy import to avoid a circular
          // module cycle (chat/lib/mentions imports this store).
          void import("@/features/chat/lib/mentions").then((m) =>
            m.publishKnowledgeToMentionCache(),
          );
        } catch {
          set({ loading: false });
        }
      },
      selectEntry: (id) => {
        const entry = get().entries.find((e) => e.id === id);
        set({
          activeEntryId: id,
          editContent: entry?.content ?? "",
        });
      },
      requestOpen: (id) => set({ pendingOpenId: id }),
      consumePendingOpen: () => set({ pendingOpenId: null }),
      setEditContent: (content) => set({ editContent: content }),
      saveEntry: async (projectPath, id, content) => {
        if (!id || !projectPath) return;
        try {
          await invoke("save_knowledge_note", {
            projectPath,
            id,
            content,
          });
          // Update the entry's content in-place without a full reload. Match on
          // the saved `id` only — if the store has since been swapped to another
          // workspace (different `entries`), this is a harmless no-op rather
          // than a cross-workspace mutation.
          const title =
            content
              .split("\n")[0]
              ?.replace(/^#+\s*/, "")
              .slice(0, 60) || "note";
          set({
            entries: get().entries.map((e) =>
              e.id === id
                ? { ...e, content, title, updated_at: new Date().toISOString() }
                : e,
            ),
          });
          invoke("log_interaction", {
            projectPath,
            interactionType: "note_edit",
            summary: `Edited note: ${title}`,
          }).catch(() => {});
          logEvent({
            source: "knowledge",
            kind: "note-save",
            summary: title,
            projectPath,
            payload: { id },
          });
        } catch {
          // silent
        }
      },
      createEntry: async (projectPath) => {
        const id = `note-${Date.now()}`;
        const content = "# Untitled\n\n";
        try {
          await invoke("save_knowledge_note", {
            projectPath,
            id,
            content,
          });
          await get().actions.loadEntries(projectPath);
          set({ activeEntryId: id, editContent: content });
          logEvent({
            source: "knowledge",
            kind: "note-create",
            summary: "New note",
            projectPath,
            payload: { id },
          });
        } catch {
          // silent
        }
      },
      deleteEntry: async (projectPath, id) => {
        try {
          await invoke("delete_knowledge_note", { projectPath, id });
          await get().actions.loadEntries(projectPath);
          logEvent({
            source: "knowledge",
            kind: "note-delete",
            summary: id,
            projectPath,
            payload: { id },
          });
        } catch {
          // silent
        }
      },
      createDir: async (projectPath, dirName) => {
        try {
          await invoke("create_knowledge_dir", { projectPath, dirName });
          await get().actions.loadEntries(projectPath);
          logEvent({
            source: "knowledge",
            kind: "dir-create",
            summary: dirName,
            projectPath,
            payload: { dirName },
          });
        } catch (e) {
          console.error("Failed to create directory:", e);
        }
      },
    },
  })),
);
