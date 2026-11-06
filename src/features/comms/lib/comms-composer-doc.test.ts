// @vitest-environment happy-dom
//
// Team chat's wire text through the composer's document and back. The body
// the server receives is the contract — `<@user_id>` tokens and bare
// `@channel` / `@here` — so text → doc → text must be the identity for every
// shape a message takes, and the pills in between must be exactly the ones
// the message renderer would draw.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { docChips, docToText, textToDoc } from "@/components/composer/composer-doc";
import { CommsMention, pillFromHTML } from "../components/comms-mention-pill";
import type { OrgMemberProfile } from "../types";
import { COMMS_MENTION, commsSerializer, type CommsMentionData } from "./comms-composer-doc";

const grace: OrgMemberProfile = {
  id: "u_grace",
  name: "Grace Hopper",
  email: "grace@x.test",
  role: "member",
};
const members = new Map([[grace.id, grace]]);
const serializer = commsSerializer(() => members);

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

function doc(text: string) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        trailingNode: false,
        underline: false,
      }),
      CommsMention,
    ],
    content: textToDoc(text, serializer),
  });
  editors.push(editor);
  return editor.state.doc;
}

const pills = (text: string): CommsMentionData[] =>
  docChips(doc(text), COMMS_MENTION).map((n) => n.attrs.data as CommsMentionData);

describe("text ↔ doc", () => {
  it.each([
    "",
    "plain message",
    "hey <@u_grace>, look",
    "<@u_grace><@u_grace>",
    "@channel ship it",
    "@here",
    "first line\n\nthird <@u_grace>\n",
    "a `<@u_grace>` span",
    "```\n<@u_grace> @here\n```\nafter <@u_grace>",
    "unknown <@u_ghost> stays",
    "email@here.com and a@channel",
    "**bold** _it_ > quote\n- list <@u_grace>",
  ])("round-trips %j", (text) => {
    expect(docToText(doc(text), serializer)).toBe(text);
  });
});

describe("what becomes a pill", () => {
  it("a member the roster names, and a broadcast", () => {
    expect(pills("hey <@u_grace> and @channel / @here")).toEqual([
      { userId: "u_grace" },
      { broadcast: "channel" },
      { broadcast: "here" },
    ]);
  });

  it("not an id nobody can name", () => {
    expect(pills("<@u_ghost>")).toEqual([]);
  });

  it("not inside a code span or a fence, but again after the fence", () => {
    expect(pills("a `<@u_grace>` span")).toEqual([]);
    expect(pills("```\n<@u_grace>\n```\nafter <@u_grace>")).toEqual([{ userId: "u_grace" }]);
  });

  it("reads fences the way the renderer's CommonMark does", () => {
    // An info string cannot close a fence: ```js inside one is code.
    expect(pills("```\n```js\n<@u_grace>\n```")).toEqual([]);
    // Tilde fences count, and a backtick line does not close one.
    expect(pills("~~~\n<@u_grace>\n```\n<@u_grace>\n~~~")).toEqual([]);
    // A shorter run does not close a longer fence.
    expect(pills("````\n```\n<@u_grace>\n````\nafter <@u_grace>")).toEqual([{ userId: "u_grace" }]);
  });

  it("not an @ inside a word", () => {
    expect(pills("email@here.com and a@channel")).toEqual([]);
  });
});

describe("a pill pasted as HTML", () => {
  it("keeps exactly one of the two shapes and nothing else", () => {
    expect(pillFromHTML({ userId: "u_grace", extra: 1 })).toEqual({ userId: "u_grace" });
    expect(pillFromHTML({ broadcast: "here" })).toEqual({ broadcast: "here" });
    for (const bad of [{}, { userId: "" }, { userId: 3 }, { broadcast: "everyone" }]) {
      expect(pillFromHTML(bad)).toBeNull();
    }
  });
});
