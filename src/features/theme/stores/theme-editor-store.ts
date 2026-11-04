import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import type { ThemeAppearance } from "@tryatlas/design/theme";

/**
 * Whether the theme editor is open, and on what. The panel is mounted once at the app root and floats
 * over the live app, so the session lives here rather than in the settings
 * page that opened it — closing Settings must not close the editor.
 *
 *   create     a new theme from the seeds (background, foreground, primary)
 *              of `sourceId`, so everything else derives (ADR-0022)
 *   duplicate  a new theme holding every value `sourceId` writes
 *   edit       `sourceId` itself, a user theme, saved back under its id
 *
 * `id` changes on every open, so the panel can tell a fresh session from a
 * re-render of the old one.
 */
export type ThemeEditorKind = "create" | "duplicate" | "edit";

export interface ThemeEditorSession {
  id: number;
  kind: ThemeEditorKind;
  sourceId: string;
  initialAppearance: ThemeAppearance;
}

interface ThemeEditorState {
  session: ThemeEditorSession | null;
  actions: {
    open: (session: Omit<ThemeEditorSession, "id">) => void;
    close: () => void;
  };
}

let nextSessionId = 0;

export const useThemeEditorStore = createSelectors(
  create<ThemeEditorState>()(
    immer((set) => ({
      session: null,
      actions: {
        open: (session) =>
          set((s) => {
            nextSessionId += 1;
            s.session = { ...session, id: nextSessionId };
          }),
        close: () =>
          set((s) => {
            s.session = null;
          }),
      },
    })),
  ),
);
