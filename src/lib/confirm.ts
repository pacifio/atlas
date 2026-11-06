import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

/**
 * A yes/no question the app asks before doing something it can't undo:
 * `await confirm({...})` resolves `true` on the confirm button and `false` on
 * Cancel, Escape or a click outside. `ConfirmDialog` renders it, mounted once
 * in App.
 *
 * A question with a third answer ("Save" / "Don't save" / "Cancel") names it
 * in `alternateLabel` and is asked with `choose()`, which resolves which of
 * the three was picked.
 *
 * `window.confirm` is not an option: on Windows (WebView2) it returns `true`
 * without showing anything.
 */
export interface ConfirmPrompt {
  title: string;
  body: string;
  confirmLabel: string;
  /** A second way forward, between Cancel and the confirm button. */
  alternateLabel?: string;
  /** Red confirm button: the action loses something. */
  destructive?: boolean;
  /** Red alternate button: that answer loses something. */
  alternateDestructive?: boolean;
  /**
   * Which `ConfirmDialog` shows it. A question asked from inside another
   * dialog has to render inside that dialog's tree, or a click on it reads as
   * a click outside and closes the dialog that asked. That dialog mounts its
   * own `<ConfirmDialog scope="…" />` and passes the same name here.
   */
  scope?: string;
}

/** Which button answered: Escape and a click outside are `"cancel"`. */
export type ConfirmChoice = "confirm" | "alternate" | "cancel";

interface ConfirmState {
  pending: (ConfirmPrompt & { resolve: (choice: ConfirmChoice) => void }) | null;
  actions: {
    ask: (prompt: ConfirmPrompt) => Promise<ConfirmChoice>;
    settle: (choice: ConfirmChoice) => void;
  };
}

const useConfirmStoreBase = create<ConfirmState>((set, get) => ({
  pending: null,
  actions: {
    ask: (prompt) =>
      new Promise<ConfirmChoice>((resolve) => {
        // A newer question supersedes an unanswered one; the old caller hears
        // "cancel" so its promise never dangles.
        get().pending?.resolve("cancel");
        set({ pending: { ...prompt, resolve } });
      }),
    settle: (choice) => {
      const pending = get().pending;
      if (!pending) return;
      set({ pending: null });
      pending.resolve(choice);
    },
  },
}));

export const useConfirmStore = createSelectors(useConfirmStoreBase);

export function confirm(prompt: ConfirmPrompt): Promise<boolean> {
  return useConfirmStore
    .getState()
    .actions.ask(prompt)
    .then((choice) => choice === "confirm");
}

/** Ask a question with up to three answers; see `ConfirmPrompt.alternateLabel`. */
export function choose(prompt: ConfirmPrompt): Promise<ConfirmChoice> {
  return useConfirmStore.getState().actions.ask(prompt);
}
