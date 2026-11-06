// @vitest-environment happy-dom
//
// WebKitGTK's paste event is blank for a clipboard image and carries no data
// for a copied file, so on Linux the composer asks Rust what GTK's clipboard
// holds (`clipboard_paste_paths`) and routes the answer through
// `onPastePaths`. Guarded here because no Mac or
// browser run ever takes this branch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn<(cmd: string) => Promise<unknown>>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/platform", () => ({ isMac: false, isWindows: false, isLinux: true }));

import { createRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { ComposerSerializer } from "./composer-doc";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor";

const IMAGE = "/home/u/.cache/dev.atlas.ide/pasted/pasted-1.png";
const FILES = ["/home/u/a.png", "/home/u/b.txt"];

const serializer: ComposerSerializer = {
  tokenize: (lines) => lines.map((line) => (line ? [{ type: "text", text: line }] : [])),
  chipText: () => "",
};

function mount(onPastePaths?: (paths: string[]) => void) {
  const ref = createRef<ComposerEditorHandle>();
  const { container } = render(
    <ComposerEditor
      ref={ref}
      extensions={[]}
      serializer={serializer}
      initialValue=""
      enterToSend={false}
      onPastePaths={onPastePaths}
    />,
  );
  return {
    dom: container.querySelector(".ProseMirror") as HTMLElement,
    value: () => ref.current!.getValue(),
  };
}

/** A paste carrying these flavours. None at all is what WebKitGTK sends for
 *  an image; a bare, empty `text/uri-list` is a copied file. */
function paste(dom: HTMLElement, flavours: Record<string, string> = {}) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => flavours[type] ?? "",
      types: Object.keys(flavours),
      items: [],
      files: [],
    },
  });
  act(() => {
    dom.dispatchEvent(event);
  });
  return event;
}

const calls = () => invoke.mock.calls.map((c) => c[0]);

beforeEach(() => {
  invoke.mockReset();
});
afterEach(cleanup);

describe("a blank paste on Linux", () => {
  it("attaches the image GTK's clipboard holds", async () => {
    invoke.mockResolvedValue([IMAGE]);
    const onPastePaths = vi.fn();
    const { dom } = mount(onPastePaths);
    const event = paste(dom);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(onPastePaths).toHaveBeenCalledWith([IMAGE]));
    expect(calls()).toEqual(["clipboard_paste_paths"]);
  });

  it("attaches copied files the event listed but could not read", async () => {
    invoke.mockResolvedValue(FILES);
    const onPastePaths = vi.fn();
    const { dom } = mount(onPastePaths);
    paste(dom, { "text/uri-list": "" });
    await waitFor(() => expect(onPastePaths).toHaveBeenCalledWith(FILES));
    expect(calls()).toEqual(["clipboard_paste_paths"]);
  });

  it("inserts nothing when the clipboard is empty", async () => {
    invoke.mockResolvedValue([]);
    const onPastePaths = vi.fn();
    const { dom, value } = mount(onPastePaths);
    paste(dom);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(onPastePaths).not.toHaveBeenCalled();
    expect(value()).toBe("");
  });

  it("asks nothing for a text paste", () => {
    const onPastePaths = vi.fn();
    const { dom, value } = mount(onPastePaths);
    paste(dom, { "text/plain": "hello" });
    expect(value()).toBe("hello");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stays out of a composer that cannot attach paths", () => {
    const { dom } = mount();
    const event = paste(dom);
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
