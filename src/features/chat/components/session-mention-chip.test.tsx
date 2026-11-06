// @vitest-environment happy-dom
//
// Where a session chip's record may come from. A video `@file` chip's hover
// preview allow-lists the file's directory for the asset protocol, so only a
// chip the user picked or dropped may preview: one rebuilt from typed or
// pasted text shows its icon and name and asks Rust for nothing. HTML is never
// a source of chip records: a pasted chip comes back through its text, which
// the tokenizer resolves against the current project like anything typed, so
// a label cannot disagree with the path it sends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { createRef } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";

import { resetMentionRegistryForTests, rememberMention } from "../lib/mention-registry";
import type { MentionData } from "../lib/mentions";
import { ChatInput, type ChatInputHandle } from "./chat-input";
import { pickedChip } from "./session-mention-chip";
import { SessionProjectsContext } from "../hooks/use-session-projects";
import { useSessionProjectsStore } from "../stores/session-projects-store";

const PROJECT = "/abs";
const CLIP: MentionData = {
  kind: "file",
  id: "/abs/media/clip.mp4",
  displayName: "/abs/media/clip.mp4",
  absPath: "/abs/media/clip.mp4",
};

beforeEach(() => {
  invoke.mockClear();
  resetMentionRegistryForTests();
});
afterEach(cleanup);

function mount(initialValue = "") {
  const ref = createRef<ChatInputHandle>();
  const view = render(<ChatInput ref={ref} initialValue={initialValue} projectPath={PROJECT} />);
  const pm = view.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
  return { ref, editor: pm.editor, dom: pm, container: view.container };
}

async function hoverChip(container: HTMLElement) {
  // Node views mount through React after the editor's own render.
  const chip = await waitFor(() => {
    const el = container.querySelector(".atlas-mention-chip");
    expect(el).not.toBeNull();
    return el!;
  });
  fireEvent.mouseEnter(chip);
  // The preview loads after a 200 ms hover.
  await act(() => new Promise((r) => setTimeout(r, 300)));
}

/** A paste event carrying these clipboard flavours. */
function paste(dom: HTMLElement, flavours: Record<string, string>) {
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
}

const allowCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "asset_allow_dir");

describe("media preview provenance", () => {
  it("a chip rebuilt from typed text previews nothing and allow-lists nothing", async () => {
    const { ref, container } = mount("look at @file:/abs/media/clip.mp4");
    expect(ref.current!.getMentions()).toEqual([CLIP]);
    await hoverChip(container);
    expect(allowCalls()).toEqual([]);
    expect(document.querySelector(".atlas-mention-preview")).toBeNull();
  });

  it("a picked chip previews, and its flag never leaves the composer", async () => {
    const { ref, container } = mount();
    act(() => ref.current!.insertMention(CLIP));
    expect(ref.current!.getMentions()).toEqual([CLIP]);
    await hoverChip(container);
    expect(allowCalls()).toEqual([["asset_allow_dir", { path: "/abs/media" }]]);
  });

  it("a picked chip restored from its text is still picked", async () => {
    rememberMention(pickedChip(CLIP), PROJECT);
    const { container } = mount("again @file:/abs/media/clip.mp4");
    await hoverChip(container);
    expect(allowCalls()).toHaveLength(1);
  });
});

describe("chips pasted as HTML", () => {
  const LIAR = {
    kind: "file",
    id: "/Users/u/.ssh/id_rsa",
    absPath: "/Users/u/.ssh/id_rsa",
    displayName: "README.md",
  };
  const span = (payload: string, text: string) =>
    `<span data-composer-chip="sessionMention" data-chip='${payload}'>${text}</span>`;

  it("never takes a path from the record: the label's own text is what resolves", () => {
    const { ref, editor } = mount();
    act(() => {
      editor.view.pasteHTML(span(JSON.stringify(LIAR), "README.md"));
    });
    expect(ref.current!.getMentions()).toEqual([]);
    expect(ref.current!.getValue()).toBe("README.md");
  });

  it("a paste with HTML takes the text flavour, rebuilt under the current project", () => {
    const { ref, dom } = mount();
    paste(dom, {
      "text/html": span(JSON.stringify({ ...LIAR, picked: true }), "@file:README.md"),
      "text/plain": "@file:README.md",
    });
    expect(ref.current!.getMentions()).toEqual([
      {
        kind: "file",
        id: "/abs/README.md",
        displayName: "README.md",
        absPath: "/abs/README.md",
      },
    ]);
  });

  it("a copied picked chip pasted back is still picked", async () => {
    const { ref, dom, container } = mount();
    act(() => ref.current!.insertMention(CLIP));
    paste(dom, {
      "text/html": span(JSON.stringify(CLIP), "@file:/abs/media/clip.mp4"),
      "text/plain": " @file:/abs/media/clip.mp4",
    });
    expect(ref.current!.getMentions()).toEqual([CLIP, CLIP]);
    await hoverChip(container);
    expect(allowCalls()).toHaveLength(1);
  });

  it.each(["null", "[1,2]", "3", '"text"', "{not json"])(
    "pastes a %s payload as text, and the value still serializes",
    (payload) => {
      const { ref, editor } = mount();
      act(() => {
        editor.view.pasteHTML(span(payload, "@file:gone"));
      });
      expect(ref.current!.getMentions()).toEqual([]);
      expect(ref.current!.getValue()).toBe("@file:gone");
    },
  );
});

describe("a project chip's access toggle", () => {
  const SERVER: MentionData = {
    kind: "workspace",
    id: "ws-2",
    displayName: "server",
    absPath: "/work/server",
    orgName: null,
  };
  const attached = (access: "read_only" | "read_write") => ({
    path: "/work/server",
    displayName: "server",
    access,
    attachedAt: "2026-10-24T00:00:00Z",
    source: "mention" as const,
  });

  function mountInSession() {
    const ref = createRef<ChatInputHandle>();
    const view = render(
      <SessionProjectsContext.Provider value="sess-1">
        <ChatInput ref={ref} projectPath={PROJECT} />
      </SessionProjectsContext.Provider>,
    );
    return { ref, container: view.container };
  }

  afterEach(() => {
    act(() => useSessionProjectsStore.getState().actions.replace("sess-1", []));
    invoke.mockImplementation(async () => null);
  });

  it("is absent until the project is attached to the session", async () => {
    const { ref, container } = mountInSession();
    act(() => ref.current!.insertMention(SERVER));
    await waitFor(() => expect(container.querySelector(".atlas-mention-chip")).not.toBeNull());
    expect(container.querySelector("[data-project-access]")).toBeNull();
  });

  it("shows read-only and asks Rust for write access on a click", async () => {
    act(() =>
      useSessionProjectsStore.getState().actions.replace("sess-1", [attached("read_only")]),
    );
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "session_projects_set_access"
        ? { projects: [attached("read_write")], changed: true, appliedLive: true }
        : null,
    );
    const { ref, container } = mountInSession();
    act(() => ref.current!.insertMention(SERVER));
    const toggle = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-project-access]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(toggle.dataset.projectAccess).toBe("read_only");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        container.querySelector("[data-project-access]")?.getAttribute("data-project-access"),
      ).toBe("read_write"),
    );
    expect(invoke).toHaveBeenCalledWith("session_projects_set_access", {
      sessionId: "sess-1",
      path: "/work/server",
      access: "read_write",
    });
  });
});

describe("a review comment's chip", () => {
  const REVIEW: MentionData = {
    kind: "review_comment",
    id: "r1x2y3",
    displayName: "src/a.ts:2-3",
    sectionId: "changes",
    sectionTitle: "Changes",
    filePath: "src/a.ts",
    rangeLabel: "2 to 3",
    diff: "+TWO",
    fenceLanguage: "diff",
    text: "Why uppercase?",
    start: 2,
    end: 3,
    side: "additions",
    endSide: "additions",
  };

  it("comes back from its token, labelled with the line reference", async () => {
    rememberMention(REVIEW, PROJECT);
    const { ref, container } = mount("see @review:r1x2y3");
    expect(ref.current!.getMentions()).toEqual([REVIEW]);
    const chip = await waitFor(() => {
      const el = container.querySelector(".atlas-mention-chip");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(chip.textContent).toContain("src/a.ts:2-3");
  });

  it("its × takes it out of the draft", async () => {
    const { ref, container } = mount();
    act(() => ref.current!.insertMention(REVIEW));
    const x = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-chip-remove]");
      expect(el).not.toBeNull();
      return el!;
    });
    act(() => {
      fireEvent.click(x);
    });
    expect(ref.current!.getMentions()).toEqual([]);
  });

  it("is removed by kind and id, as an annotation's delete asks", () => {
    const { ref } = mount();
    act(() => ref.current!.insertMention(REVIEW));
    let removed = false;
    act(() => {
      removed = ref.current!.removeMention("review_comment", "r1x2y3");
    });
    expect(removed).toBe(true);
    expect(ref.current!.getMentions()).toEqual([]);
    expect(ref.current!.removeMention("review_comment", "r1x2y3")).toBe(false);
  });

  it("a file chip has no ×", async () => {
    const { ref, container } = mount();
    act(() => ref.current!.insertMention(CLIP));
    await waitFor(() => expect(container.querySelector(".atlas-mention-chip")).not.toBeNull());
    expect(container.querySelector("[data-chip-remove]")).toBeNull();
  });
});
