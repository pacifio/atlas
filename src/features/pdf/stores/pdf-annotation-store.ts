import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/features/app/stores/app-store";
import { PDF_COLORS, type PdfAnnotation, type PdfTool } from "../lib/pdf-annotations";

interface PdfAnnotationState {
  tool: PdfTool;
  color: string;
  /** Editable annotations per PDF absolute path. Mirrored to disk
   *  (`.atlas/pdf-annotations.json`) so they persist AND stay erasable. */
  byPath: Record<string, PdfAnnotation[]>;
  /** Per-path unsaved-changes flag (drives the dirty dot). Cleared once the
   *  debounced/explicit save lands. */
  dirty: Record<string, boolean>;
  /** Currently-selected annotation id (for the note editor), or null. */
  selectedId: string | null;
  actions: {
    setTool: (tool: PdfTool) => void;
    setColor: (color: string) => void;
    select: (id: string | null) => void;
    add: (pdfPath: string, ann: PdfAnnotation) => void;
    updateNoteText: (pdfPath: string, id: string, text: string) => void;
    remove: (pdfPath: string, id: string) => void;
    /** Load persisted annotations for a PDF into the store. */
    load: (pdfPath: string) => Promise<void>;
    /** Persist a PDF's annotations now (also called debounced after edits).
     *  Resolves once written so Cmd+S can await + toast. */
    save: (pdfPath: string) => Promise<void>;
  };
}

// Debounced per-path autosave so edits aren't lost on tab close / crash.
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function scheduleSave(pdfPath: string): void {
  if (saveTimers[pdfPath]) clearTimeout(saveTimers[pdfPath]);
  saveTimers[pdfPath] = setTimeout(() => {
    delete saveTimers[pdfPath];
    void usePdfAnnotationStore.getState().actions.save(pdfPath);
  }, 600);
}

export const usePdfAnnotationStore = createSelectors(
  create<PdfAnnotationState>()(
    immer((set, get) => ({
      tool: "none",
      color: PDF_COLORS[0],
      byPath: {},
      dirty: {},
      selectedId: null,
      actions: {
        setTool: (tool) =>
          set((s) => {
            s.tool = tool;
            if (tool !== "none") s.selectedId = null;
          }),
        setColor: (color) =>
          set((s) => {
            s.color = color;
          }),
        select: (id) =>
          set((s) => {
            s.selectedId = id;
          }),
        add: (pdfPath, ann) => {
          set((s) => {
            const list = s.byPath[pdfPath] ?? [];
            list.push(ann);
            s.byPath[pdfPath] = list;
            s.dirty[pdfPath] = true;
            if (ann.kind === "note") s.selectedId = ann.id;
          });
          scheduleSave(pdfPath);
        },
        updateNoteText: (pdfPath, id, text) => {
          set((s) => {
            const ann = s.byPath[pdfPath]?.find((a) => a.id === id);
            if (ann && ann.kind === "note") {
              ann.text = text;
              s.dirty[pdfPath] = true;
            }
          });
          scheduleSave(pdfPath);
        },
        remove: (pdfPath, id) => {
          set((s) => {
            s.byPath[pdfPath] = (s.byPath[pdfPath] ?? []).filter((a) => a.id !== id);
            s.dirty[pdfPath] = true;
            if (s.selectedId === id) s.selectedId = null;
          });
          scheduleSave(pdfPath);
        },
        load: async (pdfPath) => {
          const projectPath = useAppStore.getState().currentProject?.path;
          if (!projectPath) return;
          try {
            const anns = await invoke<PdfAnnotation[]>("pdf_annotations_load", {
              projectPath,
              pdfPath,
            });
            set((s) => {
              s.byPath[pdfPath] = anns ?? [];
              s.dirty[pdfPath] = false;
            });
          } catch {
            /* no annotations yet */
          }
        },
        save: async (pdfPath) => {
          const projectPath = useAppStore.getState().currentProject?.path;
          if (!projectPath) return;
          const annotations = get().byPath[pdfPath] ?? [];
          try {
            await invoke("pdf_annotations_save", { projectPath, pdfPath, annotations });
            set((s) => {
              s.dirty[pdfPath] = false;
            });
          } catch {
            /* keep dirty so a later save retries */
          }
        },
      },
    })),
  ),
);
