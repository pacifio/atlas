// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { highlightingFor } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { editorThemeExtensions } from "./build-cm-theme";

/**
 * Switching the editor theme must not cost the user their work — the buffer and
 * its undo history have to survive (issue #75).
 *
 * The mechanism is a `Compartment`: the editor reconfigures the theme slot in
 * place instead of rebuilding the view. That only holds while the bundle in
 * that compartment stays state-free, so this drives the real
 * `editorThemeExtensions` through the same reconfigure the panel performs, with
 * edits and undo history in flight.
 */

const themeCompartment = new Compartment();

/** A view configured the way `EditorPanel` configures its theme slot. */
function mountEditor(doc: string, themeId: string) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [themeCompartment.of(editorThemeExtensions(themeId)), history()],
    }),
    parent: document.body,
  });
  return view;
}

function type(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    // Mirrors a keystroke: goes into the undo history.
    userEvent: "input.type",
  });
}

describe("live theme swap", () => {
  it("keeps the document across a theme change", () => {
    const view = mountEditor("const a = 1;", "atlas");
    type(view, "\nconst b = 2;");

    view.dispatch({ effects: themeCompartment.reconfigure(editorThemeExtensions("dracula")) });

    expect(view.state.doc.toString()).toBe("const a = 1;\nconst b = 2;");
    view.destroy();
  });

  it("keeps undo history usable across a theme change", () => {
    const view = mountEditor("const a = 1;", "atlas");
    type(view, "\nconst b = 2;");

    view.dispatch({ effects: themeCompartment.reconfigure(editorThemeExtensions("monokai")) });
    // The edit made *before* the swap must still be undoable after it.
    expect(undo(view)).toBe(true);

    expect(view.state.doc.toString()).toBe("const a = 1;");
    view.destroy();
  });

  it("keeps the selection across a theme change", () => {
    const view = mountEditor("const a = 1;", "atlas");
    view.dispatch({ selection: { anchor: 6, head: 11 } });

    view.dispatch({ effects: themeCompartment.reconfigure(editorThemeExtensions("one-dark")) });

    expect(view.state.selection.main.anchor).toBe(6);
    expect(view.state.selection.main.head).toBe(11);
    view.destroy();
  });

  it("survives a swap to an unknown theme id by falling back, not throwing", () => {
    const view = mountEditor("const a = 1;", "atlas");

    expect(() =>
      view.dispatch({ effects: themeCompartment.reconfigure(editorThemeExtensions("deleted-theme")) })
    ).not.toThrow();

    expect(view.state.doc.toString()).toBe("const a = 1;");
    view.destroy();
  });

  it("installs both halves of highlighting — a theme alone would not highlight", () => {
    // `editorThemeExtensions` bundles the chrome theme with `syntaxHighlighting`
    // precisely so a caller cannot install one without the other. Asserting the
    // bundle's *length* would pass for two chrome themes; ask the resulting
    // state whether a highlighter is actually answering instead.
    const state = EditorState.create({ extensions: editorThemeExtensions("atlas") });
    expect(highlightingFor(state, [tags.comment])).toBeTruthy();
  });
});
