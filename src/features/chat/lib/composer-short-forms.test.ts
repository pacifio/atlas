// @vitest-environment happy-dom
//
// The session composer's prompt text is the contract: what `getValue` returns
// is what the agent receives, byte for byte the short forms the CodeMirror
// composer wrote (`toShortForm`). This suite holds the Tiptap composer to it
// for every mention kind, and holds the way back — a draft restore, a prefill,
// a paste — to rebuilding the same chips from those tokens, so text → doc →
// text is the identity and a chip survives the trip whole.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { createElement, createRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";

import { ChatInput, type ChatInputHandle } from "../components/chat-input";
import { mentionOf, pickedChip, type SessionChipRecord } from "../components/session-mention-chip";
import { SESSION_MENTION, tokenizeShortForms } from "./composer-short-forms";
import { rememberMention, resetMentionRegistryForTests } from "./mention-registry";
import { toShortForm, type MentionData } from "./mentions";

const PROJECT = "/work/atlas";

/** One mention of every kind, values chosen to hit both the bare and the
 *  quoted short form. */
const EVERY_KIND: MentionData[] = [
  {
    kind: "file",
    id: `${PROJECT}/src/x.ts`,
    displayName: "src/x.ts",
    absPath: `${PROJECT}/src/x.ts`,
  },
  {
    kind: "folder",
    id: `${PROJECT}/My Docs`,
    displayName: "My Docs",
    absPath: `${PROJECT}/My Docs`,
  },
  {
    kind: "symbol",
    id: "parse@src/p.ts:3",
    displayName: "parse",
    signature: "fn parse()",
    filePath: "src/p.ts",
    line: 3,
    symbolKind: "function",
  },
  {
    kind: "knowledge",
    id: "Adib/weekly-notes",
    displayName: "Weekly notes",
    icon: null,
    filePath: ".atlas/knowledge/Adib/weekly-notes.md",
    source: "note",
    folder: "Adib",
  },
  {
    kind: "component",
    id: "global:rule:pack:style",
    displayName: "style",
    description: "House style",
    componentKind: "rule",
    pack: "pack",
    scope: "global",
    projectPath: null,
    filePath: "/rules/style.md",
  },
  {
    kind: "component",
    id: "global:command:pack:ship it",
    displayName: "ship it",
    description: "",
    componentKind: "command",
    pack: "pack",
    scope: "global",
    projectPath: null,
    filePath: "/commands/ship.md",
  },
  {
    kind: "repo",
    id: "/repos/tiptap",
    displayName: "tiptap",
    absPath: "/repos/tiptap",
    hasReadme: true,
  },
  { kind: "workspace", id: "p-1", displayName: "Atlas App", absPath: PROJECT, orgName: null },
  {
    kind: "branch",
    id: "feat/x",
    displayName: "feat/x",
    sha: "abcdef1",
    refKind: "branch",
    isCurrent: false,
  },
  {
    kind: "past_message",
    id: "s-1#4",
    displayName: "the earlier answer",
    sessionId: "s-1",
    sessionTitle: "Earlier",
    timestamp: "2026-10-01T10:00:00Z",
    content: "the earlier answer",
  },
  {
    kind: "past_session",
    id: "s-2",
    displayName: "Fix the theme importer",
    sessionId: "s-2",
    sessionTitle: "Fix the theme importer",
    cwd: PROJECT,
  },
  { kind: "member", id: "u-grace", displayName: "Grace Hopper", email: "grace@acme.dev" },
  { kind: "conversation", id: "c-1", displayName: "general", conversationKind: "channel" },
  {
    kind: "recorded_session",
    id: "rs-1",
    displayName: "Theme work",
    sessionId: "rs-1",
    workspaceId: "ws-1",
  },
  {
    kind: "comment",
    id: "cm-1",
    displayName: "Ada: retry here",
    workspaceId: "ws-1",
    sessionId: "rs-1",
    authorName: "Ada",
    body: "retry here",
    anchorLabel: "a prompt",
    parentId: null,
    resolved: false,
    createdAt: "2026-10-01T10:00:00Z",
  },
  {
    kind: "pasted_text",
    id: "k3x9q2",
    displayName: "Pasted text · 2 lines",
    lines: 2,
    text: "first\nsecond",
  },
  {
    kind: "cited_text",
    id: "c7m2p4",
    displayName: "“Scope it to the usage page.”",
    messageId: "msg-7",
    rowId: "am-42",
    text: "Scope it to the usage page.",
    note: "Billing too?",
  },
];

beforeEach(() => resetMentionRegistryForTests());
afterEach(() => cleanup());

/** The session composer, mounted, with its editor. */
function composer(initialValue = "") {
  const ref = createRef<ChatInputHandle>();
  const onPasteLargeText = vi.fn(() => true);
  const { container } = render(
    createElement(ChatInput, { ref, projectPath: PROJECT, initialValue, onPasteLargeText }),
  );
  const dom = container.querySelector<HTMLElement & { editor: Editor }>(".ProseMirror")!;
  return { input: ref.current!, editor: dom.editor, dom, onPasteLargeText };
}

/** The chip records in the document, in reading order. */
function chips(editor: Editor): MentionData[] {
  const out: MentionData[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === SESSION_MENTION)
      out.push(mentionOf(node.attrs.data as SessionChipRecord));
  });
  return out;
}

/** A paste through ProseMirror's own paste path. */
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

describe("every mention kind", () => {
  it.each(EVERY_KIND.map((m) => [m.kind, m] as const))(
    "%s writes its short form and comes back as the same chip",
    (_kind, mention) => {
      const first = composer();
      act(() => {
        first.input.insertText("see ");
        first.input.insertMention(mention);
        first.input.insertText("now");
      });
      const text = first.input.getValue();
      expect(text).toBe(`see ${toShortForm(mention)} now`);

      // A remount restoring that text as a draft.
      const restored = composer(text);
      expect(restored.input.getValue()).toBe(text);
      expect(chips(restored.editor)).toEqual([mention]);
    },
  );

  it("renders a view for each, file and folder chips wearing the icon theme", async () => {
    const { input, dom } = composer();
    act(() => {
      for (const m of EVERY_KIND) input.insertMention(m);
    });
    await waitFor(() =>
      expect(dom.querySelectorAll(".atlas-mention-chip")).toHaveLength(EVERY_KIND.length),
    );
    const kinds = [...dom.querySelectorAll<HTMLElement>(".atlas-mention-chip")].map(
      (c) => c.dataset.mentionKind,
    );
    expect(kinds).toEqual(EVERY_KIND.map((m) => m.kind));
  });
});

describe("text that is not a minted mention", () => {
  it("rebuilds a project-relative or absolute @file / @folder from its path", () => {
    const { input, editor } = composer("@file:src/a.ts and @folder:/abs/dir");
    expect(chips(editor)).toEqual([
      {
        kind: "file",
        id: `${PROJECT}/src/a.ts`,
        displayName: "src/a.ts",
        absPath: `${PROJECT}/src/a.ts`,
      },
      { kind: "folder", id: "/abs/dir", displayName: "/abs/dir", absPath: "/abs/dir" },
    ]);
    expect(input.getValue()).toBe("@file:src/a.ts and @folder:/abs/dir");
  });

  it("keeps a minted mention's own trailing punctuation", () => {
    const folder: MentionData = {
      kind: "folder",
      id: `${PROJECT}/v(1)`,
      displayName: "v(1)",
      absPath: `${PROJECT}/v(1)`,
    };
    rememberMention(folder, PROJECT);
    const { input, editor } = composer("in @folder:v(1)");
    expect(chips(editor)).toEqual([folder]);
    expect(input.getValue()).toBe("in @folder:v(1)");
  });

  it("leaves a token it cannot name as text, untouched", () => {
    const text = '@session:"Never minted" #rule:nope @member:someone a@file:b.ts';
    const { input, editor } = composer(text);
    expect(chips(editor)).toEqual([]);
    expect(input.getValue()).toBe(text);
  });

  it("keeps a sentence's full stop out of the path", () => {
    const tokens = tokenizeShortForms("see @file:a.ts.", {
      known: () => null,
      rebuilt: (t) => ({
        kind: "file",
        id: `/p/${t.value}`,
        displayName: t.value,
        absPath: `/p/${t.value}`,
      }),
    });
    expect(tokens).toEqual([
      { type: "text", text: "see " },
      {
        type: SESSION_MENTION,
        attrs: { data: { kind: "file", id: "/p/a.ts", displayName: "a.ts", absPath: "/p/a.ts" } },
      },
      { type: "text", text: "." },
    ]);
  });
});

describe("minted mentions belong to a project", () => {
  /** The records in the document, flag and all. */
  const raw = (editor: Editor) => {
    const out: SessionChipRecord[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === SESSION_MENTION) out.push(node.attrs.data as SessionChipRecord);
    });
    return out;
  };

  it("a token minted in another project rebuilds under this one", () => {
    rememberMention(
      pickedChip({
        kind: "file",
        id: "/other/src/main.rs",
        displayName: "src/main.rs",
        absPath: "/other/src/main.rs",
      }),
      "/other",
    );
    const { editor } = composer("@file:src/main.rs");
    expect(raw(editor)).toEqual([
      {
        kind: "file",
        id: `${PROJECT}/src/main.rs`,
        displayName: "src/main.rs",
        absPath: `${PROJECT}/src/main.rs`,
      },
    ]);
  });

  it("a minted path outside the project is not taken as minted", () => {
    const outside: MentionData = {
      kind: "file",
      id: "/elsewhere/x.ts",
      displayName: "/elsewhere/x.ts",
      absPath: "/elsewhere/x.ts",
    };
    rememberMention(pickedChip(outside), PROJECT);
    const { editor } = composer("@file:/elsewhere/x.ts");
    expect(raw(editor)).toEqual([outside]);
  });

  it("a minted path inside the project is", () => {
    const inside: MentionData = {
      kind: "file",
      id: `${PROJECT}/src/a.ts`,
      displayName: "src/a.ts",
      absPath: `${PROJECT}/src/a.ts`,
    };
    rememberMention(pickedChip(inside), PROJECT);
    expect(raw(composer("@file:src/a.ts").editor)).toEqual([{ ...inside, picked: true }]);
  });
});

describe("prompt shapes", () => {
  it.each([
    ["a slash command", "/review the diff"],
    ["a slash command with a mention", "/explain @file:src/x.ts"],
    ["a code fence", "look:\n```ts\nconst a = 1;\n\n  indented();\n```\ndone"],
    ["multiple lines and blank lines", "one\n\n\nfour\n"],
    ["markdown lists", "- one\n  - two\n1. three\n- [ ] four"],
    ["whitespace kept as typed", "  two leading\ttab  "],
  ])("round-trips %s", (_name, text) => {
    expect(composer(text).input.getValue()).toBe(text);
  });
});

describe("chips through editing", () => {
  const file = EVERY_KIND[0];
  const session = EVERY_KIND.find((m) => m.kind === "past_session")!;

  it("survives undo and redo", () => {
    const { input, editor } = composer();
    act(() => {
      input.insertMention(session);
      input.insertText("tail");
    });
    const full = input.getValue();
    act(() => {
      // Its own undo step, as a pause in typing would make it.
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.selectAll();
      editor.commands.deleteSelection();
    });
    expect(chips(editor)).toEqual([]);
    act(() => {
      editor.commands.undo();
    });
    expect(input.getValue()).toBe(full);
    expect(chips(editor)).toEqual([session]);
    act(() => {
      editor.commands.redo();
    });
    expect(chips(editor)).toEqual([]);
  });

  it("brings a picked file chip back from undo with its record and its icon", async () => {
    const { input, editor, dom } = composer();
    const picked = pickedChip(file);
    act(() => {
      editor.commands.insertContent({ type: SESSION_MENTION, attrs: { data: picked } });
    });
    act(() => {
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.selectAll();
      editor.commands.deleteSelection();
    });
    expect(input.getValue()).toBe("");
    act(() => {
      editor.commands.undo();
    });
    const records: SessionChipRecord[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === SESSION_MENTION) records.push(node.attrs.data as SessionChipRecord);
    });
    expect(records).toEqual([picked]);
    await waitFor(() =>
      expect(dom.querySelector('.atlas-mention-chip[data-mention-kind="file"]')).not.toBeNull(),
    );
  });

  it("comes back from a plain-text paste of the composer's own text", () => {
    rememberMention(session, PROJECT);
    const { input, editor, dom } = composer("before ");
    paste(dom, { "text/plain": `${toShortForm(session)} and ${toShortForm(file)}` });
    expect(chips(editor).map((m) => m.kind)).toEqual(["past_session", "file"]);
    expect(input.getValue()).toBe(`before ${toShortForm(session)} and ${toShortForm(file)}`);
  });

  it("puts the caret at the end of a restored draft", () => {
    const { editor } = composer("one\ntwo");
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
  });

  it("pastes multi-line text as lines, exactly", () => {
    const { input, dom } = composer("x");
    const text = "one\n\n  two\nthree";
    paste(dom, { "text/plain": text, "text/html": "<p>one</p><p>two</p>" });
    expect(input.getValue()).toBe(`x${text}`);
  });

  it("copies as the prompt text", () => {
    const { input, editor } = composer();
    act(() => {
      input.insertText("a\nb ");
      input.insertMention(file);
    });
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
    expect(editor.view.someProp("clipboardTextSerializer", (f) => f(slice, editor.view))).toBe(
      `a\nb ${toShortForm(file)} `,
    );
  });

  it("hands a large paste to the attachment path instead of the editor", () => {
    const { input, dom, onPasteLargeText } = composer("keep");
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    paste(dom, { "text/plain": big });
    expect(onPasteLargeText).toHaveBeenCalledWith(big);
    expect(input.getValue()).toBe("keep");
  });
});
