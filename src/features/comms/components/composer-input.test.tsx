// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/core";

import { ComposerInput, type ComposerInputHandle } from "./composer-input";
import type { OrgMemberProfile } from "../types";

const ada: OrgMemberProfile = {
  id: "u_ada",
  name: "Ada Lovelace",
  email: "ada@x.test",
  role: "member",
};
const grace: OrgMemberProfile = {
  id: "u_grace",
  name: "Grace Hopper",
  email: "grace@x.test",
  role: "member",
};
const members = new Map([
  [ada.id, ada],
  [grace.id, grace],
]);

function mount(value: string, me = "u_ada") {
  const handle = createRef<ComposerInputHandle>();
  const onChange = vi.fn();
  const onPasteLargeText = vi.fn(() => true);
  const view = render(
    <ComposerInput
      handle={handle}
      value={value}
      placeholder="Message #general"
      members={members}
      me={me}
      onChange={onChange}
      onKeyDown={() => false}
      onPaste={() => false}
      onPasteLargeText={onPasteLargeText}
    />,
  );
  const editor = view.container.querySelector<HTMLElement & { editor: Editor }>(
    ".ProseMirror",
  )!.editor;
  return { ...view, handle, editor, onChange, onPasteLargeText };
}

/** Type at the caret the way the keyboard does: one character at a time,
 *  through the editor's text-input path. */
function type(editor: Editor, text: string) {
  act(() => {
    for (const ch of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (f) =>
        f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)),
      );
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
    }
  });
}

/** The editor's text, as the wire has it. */
const text = (handle: React.RefObject<ComposerInputHandle | null>) =>
  handle.current?.getSelection().value;

/**
 * The label of each pill. Scoped to the last child on purpose: the pill also
 * contains the avatar, whose initials would otherwise show up in `textContent`
 * as `GH@Grace Hopper`.
 */
const chips = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-mention-pill] > span:last-child")].map((n) => n.textContent);

afterEach(cleanup);

describe("ComposerInput", () => {
  it("shows a mention as a named pill instead of the raw id", async () => {
    const { container } = mount("hey <@u_grace> look");
    await waitFor(() => expect(chips(container)).toEqual(["@Grace Hopper"]));
    // The id is replaced visually, never in the text that gets sent.
    expect(container.textContent).not.toContain("u_grace");
  });

  it("draws the member's face inside the pill", async () => {
    const { container } = mount("hey <@u_grace>");
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    const pill = container.querySelector("[data-mention-pill]");
    // No image on this fixture, so the avatar is the initials fallback —
    // `CommsAvatar`, as the rendered message draws it, hue derived from the id.
    const face = pill?.firstElementChild as HTMLElement;
    expect(face.textContent).toBe("GH");
    expect(face.querySelector<HTMLElement>("[style*='hsl']")).not.toBe(null);
  });

  it("gives a broadcast no face, because there is nobody to show", async () => {
    const { container } = mount("@channel");
    await waitFor(() => expect(chips(container)).toEqual(["@channel"]));
    expect(container.querySelector("[data-mention-pill]")?.children).toHaveLength(1);
  });

  it("keeps the document text exactly as the server expects", async () => {
    const { handle } = mount("hey <@u_grace>");
    await waitFor(() => expect(handle.current).not.toBe(null));
    expect(handle.current?.getSelection().value).toBe("hey <@u_grace>");
  });

  it("marks a mention of you differently from a mention of someone else", async () => {
    const { container } = mount("<@u_ada> <@u_grace>", "u_ada");
    await waitFor(() => expect(chips(container)).toHaveLength(2));
    const pills = [...container.querySelectorAll("[data-mention-pill]")];
    expect(pills[0].hasAttribute("data-mention-self")).toBe(true);
    expect(pills[1].hasAttribute("data-mention-self")).toBe(false);
  });

  it("pills a broadcast", async () => {
    const { container } = mount("@channel ship it");
    await waitFor(() => expect(chips(container)).toEqual(["@channel"]));
  });

  // A pill here would promise a pill in the message, and the renderer will
  // print this one literally.
  it("does NOT pill a mention inside code", async () => {
    const { container } = mount("try `<@u_grace>` here");
    await waitFor(() => expect(container.textContent).toContain("<@u_grace>"));
    expect(chips(container)).toEqual([]);
  });

  it("does not pill inside a fence", async () => {
    const { container } = mount("```\n<@u_grace>\n```");
    await waitFor(() => expect(container.textContent).toContain("<@u_grace>"));
    expect(chips(container)).toEqual([]);
  });

  // Naming an id we cannot resolve would hide who is about to be notified.
  it("leaves an unresolved id as the raw token", async () => {
    const { container } = mount("<@u_ghost>");
    await waitFor(() => expect(container.textContent).toContain("<@u_ghost>"));
    expect(chips(container)).toEqual([]);
  });

  it("repaints chips when the roster arrives after the draft", async () => {
    const handle = createRef<ComposerInputHandle>();
    const props = {
      handle,
      value: "<@u_ada>",
      placeholder: "Message #general",
      me: "u_grace",
      onChange: vi.fn(),
      onKeyDown: () => false,
      onPaste: () => false,
    };
    const { container, rerender } = render(<ComposerInput {...props} members={new Map()} />);
    await waitFor(() => expect(container.textContent).toContain("<@u_ada>"));
    expect(chips(container)).toEqual([]);

    rerender(<ComposerInput {...props} members={members} />);
    await waitFor(() => expect(chips(container)).toEqual(["@Ada Lovelace"]));
  });

  it("applyEdit replaces the document and reports the new selection", async () => {
    const { handle } = mount("hello");
    await waitFor(() => expect(handle.current).not.toBe(null));
    handle.current?.applyEdit({ value: "**hello**", start: 2, end: 7 });
    const sel = handle.current?.getSelection();
    expect(sel?.value).toBe("**hello**");
    expect([sel?.start, sel?.end]).toEqual([2, 7]);
  });

  it("takes an external value change, as a send clearing the draft does", async () => {
    const { handle, rerender, container } = mount("draft text");
    await waitFor(() => expect(container.textContent).toContain("draft text"));
    rerender(
      <ComposerInput
        handle={handle}
        value=""
        placeholder="Message #general"
        members={members}
        me="u_ada"
        onChange={vi.fn()}
        onKeyDown={() => false}
        onPaste={() => false}
      />,
    );
    await waitFor(() => expect(handle.current?.getSelection().value).toBe(""));
  });

  it("does not report a value that came back in, or an applyEdit, as typing", async () => {
    const { handle, rerender, onChange } = mount("a");
    rerender(
      <ComposerInput
        handle={handle}
        value="b"
        placeholder="Message #general"
        members={members}
        me="u_ada"
        onChange={onChange}
        onKeyDown={() => false}
        onPaste={() => false}
      />,
    );
    act(() => handle.current?.applyEdit({ value: "**b**", start: 2, end: 3 }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports typing with the wire text and the caret as a text offset", () => {
    const { editor, onChange } = mount("hi <@u_grace>");
    type(editor, "!");
    expect(onChange).toHaveBeenLastCalledWith("hi <@u_grace>!", "hi <@u_grace>!".length);
  });

  it("pills a broadcast once the user types past it, not while the caret is on it", async () => {
    const { editor, container, handle } = mount("");
    type(editor, "ping @here");
    expect(chips(container)).toEqual([]);
    type(editor, " now");
    await waitFor(() => expect(chips(container)).toEqual(["@here"]));
    expect(text(handle)).toBe("ping @here now");
  });

  it("pills a token a picker writes in, with the caret after it", async () => {
    const { handle, container } = mount("hey @gr");
    act(() => handle.current?.applyEdit({ value: "hey <@u_grace> ", start: 15, end: 15 }));
    await waitFor(() => expect(chips(container)).toEqual(["@Grace Hopper"]));
    const sel = handle.current?.getSelection();
    expect([sel?.start, sel?.end]).toEqual([15, 15]);
  });

  it("returns a pill to text when code closes around it", async () => {
    const { editor, container, handle } = mount("`a <@u_grace> b");
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    type(editor, "`");
    await waitFor(() => expect(chips(container)).toEqual([]));
    expect(text(handle)).toBe("`a <@u_grace> b`");
  });

  it("returns pills below a fence to text when the fence opens above them", async () => {
    const { editor, container, handle } = mount("\nsee <@u_grace>\n```");
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    act(() => {
      editor.commands.setTextSelection(1);
    });
    type(editor, "```");
    await waitFor(() => expect(chips(container)).toEqual([]));
    expect(text(handle)).toBe("```\nsee <@u_grace>\n```");
  });

  it("leaves a line alone while an input method is composing, and pills it after", async () => {
    const { editor, container, handle } = mount("");
    const input = (editor.view as unknown as { input: { composing: boolean } }).input;
    act(() => {
      input.composing = true;
      editor.view.dispatch(editor.state.tr.insertText("hi <@u_grace> ").setMeta("composition", 1));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(chips(container)).toEqual([]);
    act(() => {
      input.composing = false;
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await waitFor(() => expect(chips(container)).toEqual(["@Grace Hopper"]));
    expect(text(handle)).toBe("hi <@u_grace> ");
  });

  it("keeps a pill through undo and redo", async () => {
    const { editor, container, handle } = mount("hi <@u_grace>");
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    act(() => {
      editor.commands.selectAll();
      editor.commands.deleteSelection();
    });
    expect(text(handle)).toBe("");
    act(() => {
      editor.commands.undo();
    });
    expect(text(handle)).toBe("hi <@u_grace>");
    await waitFor(() => expect(chips(container)).toEqual(["@Grace Hopper"]));
  });

  it("hands a large paste to the attachment path", () => {
    const { editor, onPasteLargeText, handle } = mount("keep");
    const big = "x".repeat(5000);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (t: string) => (t === "text/plain" ? big : ""),
        types: ["text/plain"],
        items: [],
        files: [],
      },
    });
    act(() => {
      editor.view.dom.dispatchEvent(event);
    });
    expect(onPasteLargeText).toHaveBeenCalledWith(big);
    expect(text(handle)).toBe("keep");
  });
});
