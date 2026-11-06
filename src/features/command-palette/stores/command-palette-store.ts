// Whether the search overlay is open, and in which mode (⌘K commands or ⌘P
// files). One overlay for both, so "Go to file" from ⌘K can hand over to the
// file search and Escape can hand back.
//
// The transitions are the pure reducer in `command-palette-logic.ts`; this
// store only holds its state so the chords (App's action map), the sidebar's
// search button and the menu bar can all reach the one overlay.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import {
  INITIAL_COMMAND_PALETTE_UI_STATE,
  reduceCommandPaletteUiState,
  type CommandPaletteUiAction,
  type CommandPaletteUiState,
} from "../lib/command-palette-logic";

interface CommandPaletteStoreState {
  ui: CommandPaletteUiState;
  actions: {
    dispatch: (action: CommandPaletteUiAction) => void;
    /** ⌘K: open the palette, or close it when it is the mode on screen. */
    toggleCommands: () => void;
    /** ⌘P: open the file search, or close it when it is on screen. */
    toggleFiles: () => void;
    /** ⌘⇧O: open the palette onto the project list ("New session in…"). */
    openProjectPicker: () => void;
    /** ⌘⇧N and the sidebar's "Add project": the palette's source list. */
    openAddProject: () => void;
    setOpen: (open: boolean) => void;
  };
}

export const useCommandPaletteStore = createSelectors(
  create<CommandPaletteStoreState>()((set, get) => {
    const dispatch = (action: CommandPaletteUiAction) =>
      set({ ui: reduceCommandPaletteUiState(get().ui, action) });
    return {
      ui: INITIAL_COMMAND_PALETTE_UI_STATE,
      actions: {
        dispatch,
        toggleCommands: () => dispatch({ _tag: "ToggleMode", mode: "command" }),
        toggleFiles: () => dispatch({ _tag: "ToggleMode", mode: "files" }),
        openProjectPicker: () => dispatch({ _tag: "OpenView", view: "new-session-in" }),
        openAddProject: () => dispatch({ _tag: "OpenView", view: "add-project" }),
        setOpen: (open) => dispatch({ _tag: "SetOpen", open }),
      },
    };
  }),
);
