// The editors installed on this machine, as Rust detected them. Loaded on
// first use, once per launch; Settings can ask for a fresh probe.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { detectExternalEditors, type ExternalEditor } from "../lib/external-editor-api";

interface ExternalEditorState {
  /** Null until the first probe answers. */
  editors: ExternalEditor[] | null;
  actions: {
    /** The detected list, probing only if nothing has been loaded yet (or
     *  `refresh`). Concurrent callers share one probe. */
    load: (refresh?: boolean) => Promise<ExternalEditor[]>;
  };
}

let inflight: Promise<ExternalEditor[]> | null = null;

export const useExternalEditorStore = createSelectors(
  create<ExternalEditorState>()((set, get) => ({
    editors: null,
    actions: {
      load: (refresh = false) => {
        const loaded = get().editors;
        if (loaded && !refresh) return Promise.resolve(loaded);
        if (inflight && !refresh) return inflight;
        const probe = detectExternalEditors(refresh)
          .then((editors) => {
            // An unmocked or failed probe still leaves the system default.
            const list = editors ?? [];
            set({ editors: list });
            return list;
          })
          .catch(() => {
            set({ editors: [] });
            return [];
          })
          .finally(() => {
            if (inflight === probe) inflight = null;
          });
        inflight = probe;
        return probe;
      },
    },
  })),
);
