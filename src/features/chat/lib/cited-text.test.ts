import { beforeEach, describe, expect, it } from "vitest";

import {
  CITE_MAX_CHARS,
  capCitation,
  cutText,
  citeAsText,
  citeLabel,
  citedTextMention,
  collapseCites,
  withCitesInline,
} from "./cited-text";
import { collapsePastes, pastedTextMention, withPastesInline } from "./pasted-text";
import { knownMention, forgetSentTexts, rememberMention } from "./mention-registry";
import { resetMentionRegistryForTests } from "./mention-registry";
import { toShortForm } from "./mentions";

beforeEach(() => resetMentionRegistryForTests());

const cite = (over: Partial<Parameters<typeof citedTextMention>[0]> = {}, id = "k3x9q2") =>
  citedTextMention(
    {
      text: "Scope it to the usage page.\nThen refresh on focus.",
      note: "Does billing need this too?",
      messageId: "msg-7",
      rowId: "am-42",
      ...over,
    },
    id,
  );

describe("a cite", () => {
  it("writes `@cite:<id>` and labels itself with the start of the passage", () => {
    const c = cite();
    expect(toShortForm(c)).toBe("@cite:k3x9q2");
    expect(c.displayName).toBe("“Scope it to the usage page. The…”");
    expect(citeLabel("short")).toBe("“short”");
  });

  it("caps the passage at CITE_MAX_CHARS, ellipsis included, and capping again changes nothing", () => {
    const long = "x".repeat(CITE_MAX_CHARS * 2);
    const capped = capCitation(long);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toHaveLength(CITE_MAX_CHARS);
    expect(capped.text.endsWith("…")).toBe(true);
    expect(capCitation(capped.text)).toEqual({ text: capped.text, truncated: false });
    expect(cite({ text: long }).text).toBe(capped.text);
  });

  it("normalises line endings, trims blank edges and the note", () => {
    const c = cite({ text: "\n\r\n  one\r\ntwo  \n\n", note: "  hi  " });
    expect(c.text).toBe("  one\ntwo  ");
    expect(c.note).toBe("hi");
    expect(cite({ rowId: undefined, note: undefined })).toMatchObject({ rowId: null, note: "" });
  });
});

/** Whether `s` holds a lone UTF-16 surrogate (half an emoji). */
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("cutting never splits an emoji", () => {
  it("drops a pair the cut would split", () => {
    expect(cutText("ab🙂", 3)).toBe("ab");
    expect(cutText("ab🙂", 4)).toBe("ab🙂");
  });

  it("at the passage cap", () => {
    // The emoji's first half lands exactly on the last unit before the `…`.
    const text = `${"x".repeat(CITE_MAX_CHARS - 2)}🙂${"y".repeat(10)}`;
    const capped = capCitation(text).text;
    expect(hasLoneSurrogate(capped)).toBe(false);
    expect(capped.length).toBeLessThanOrEqual(CITE_MAX_CHARS);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("at the label cut", () => {
    const label = citeLabel(`${"x".repeat(30)}🙂 and more`);
    expect(hasLoneSurrogate(label)).toBe(false);
    expect(label).toBe(`“${"x".repeat(30)}…”`);
  });

  it("in the note, which is capped too", () => {
    const note = `${"n".repeat(CITE_MAX_CHARS - 1)}🙂 tail`;
    const c = cite({ note });
    expect(hasLoneSurrogate(c.note)).toBe(false);
    expect(c.note.length).toBeLessThanOrEqual(CITE_MAX_CHARS);
  });
});

describe("the inline form, for paths that carry a string", () => {
  it.each([
    ["with a note and a row", cite()],
    ["without a note", cite({ note: "" })],
    ["without a row", cite({ rowId: null })],
    ["holding backtick fences", cite({ text: "```ts\nconst a = 1;\n```", note: "`b` ````" })],
    ["with odd ids", cite({ messageId: "m 1,(x)", rowId: "row/2 %" })],
  ])("comes back as the same chip %s", (_name, c) => {
    const prose = `why ${toShortForm(c)}`;
    const queued = withCitesInline(prose, [c]);
    expect(queued.startsWith(`${prose}\n\nCited passage (@cite:${c.id}`)).toBe(true);
    expect(collapseCites(queued)).toEqual({ text: prose, cites: [c] });
  });

  it("round-trips several cites after the pastes the queue writes first", () => {
    const a = cite({}, "aaaaaa");
    const b = cite({ text: "second", note: "" }, "bbbbbb");
    const paste = pastedTextMention("one\ntwo", "pppppp");
    const prose = "compare @cite:aaaaaa @cite:bbbbbb @paste:pppppp";
    const queued = withCitesInline(withPastesInline(prose, [a, paste, b]), [a, paste, b]);
    const uncited = collapseCites(queued);
    expect(uncited.cites).toEqual([a, b]);
    expect(collapsePastes(uncited.text)).toEqual({ text: prose, pastes: [paste] });
  });

  it("leaves text alone when its tail is not exactly cite blocks", () => {
    const text = `${citeAsText(cite())}\nand then some`;
    expect(collapseCites(`hi\n\n${text}`)).toEqual({ text: `hi\n\n${text}`, cites: [] });
    expect(collapseCites("no cites")).toEqual({ text: "no cites", cites: [] });
    expect(withCitesInline("plain", [])).toBe("plain");
  });
});

describe("the mention registry", () => {
  it("remembers a cite until it is sent, so a draft restore finds it", () => {
    const c = cite();
    rememberMention(c, "/p");
    expect(knownMention("@cite:k3x9q2", "/p")).toEqual(c);
    forgetSentTexts([c]);
    expect(knownMention("@cite:k3x9q2", "/p")).toBeNull();
  });
});
