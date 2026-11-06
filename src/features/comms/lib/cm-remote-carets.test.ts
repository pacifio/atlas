// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { remoteCaretField, setRemoteCarets } from "./cm-remote-carets";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string): EditorView {
  view = new EditorView({ doc, extensions: [remoteCaretField], parent: document.body });
  return view;
}

const flags = (v: EditorView) =>
  [...v.dom.querySelectorAll(".atlas-remote-caret")].map((el) => ({
    name: el.lastElementChild?.textContent,
    bar: el.firstElementChild?.className,
  }));

describe("remote carets", () => {
  it("paints each caret in its person's hue, through classes not inline colour", () => {
    const v = mount("hello world");
    v.dispatch({
      effects: setRemoteCarets.of([{ userId: "u1", cursor: 3, name: "Priya", tone: "cyan" }]),
    });
    expect(flags(v)).toEqual([{ name: "Priya", bar: "bg-hue-cyan rounded-full" }]);
    const flag = v.dom.querySelector(".atlas-remote-caret")!.lastElementChild as HTMLElement;
    expect(flag.className).toContain("bg-hue-cyan");
    expect(flag.style.background).toBe("");
  });

  it("clamps a cursor past the end of the document", () => {
    const v = mount("short");
    v.dispatch({
      effects: setRemoteCarets.of([{ userId: "u1", cursor: 999, name: "Tobi", tone: "blue" }]),
    });
    const set = v.state.field(remoteCaretField);
    const at: number[] = [];
    set.between(0, v.state.doc.length, (from) => {
      at.push(from);
    });
    expect(at).toEqual([5]);
  });

  it("keeps a caret riding its text through a local edit above it", () => {
    const v = mount("abcdef");
    v.dispatch({
      effects: setRemoteCarets.of([{ userId: "u1", cursor: 4, name: "Priya", tone: "red" }]),
    });
    v.dispatch({ changes: { from: 0, insert: "XY" } });
    const at: number[] = [];
    v.state.field(remoteCaretField).between(0, v.state.doc.length, (from) => {
      at.push(from);
    });
    expect(at).toEqual([6]);
  });
});
