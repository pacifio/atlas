// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { tags } from "@lezer/highlight";
import type { Tag } from "@lezer/highlight";
import { buildHighlightStyle } from "./build-cm-theme";
import { EDITOR_THEMES } from "./themes";

/**
 * A `HighlightStyle` colors only the tags it names; a grammar tag with no rule
 * renders in the plain foreground. So "the file has a language extension" is
 * only half of "the file looks highlighted" — a Markdown buffer parsed
 * perfectly still arrived as flat grey text because no prose tag had a rule
 * (issue #75).
 *
 * These pin the tags that must resolve to a style, for every theme.
 */

/**
 * Tags a reader would notice missing. Child tags resolve through their parent
 * (`tags.controlKeyword` → `tags.keyword`), so entries like `controlKeyword`
 * also assert that inheritance still holds.
 */
const CODE_TAGS: Array<[string, Tag]> = [
  ["comment", tags.comment],
  ["blockComment", tags.blockComment],
  ["keyword", tags.keyword],
  ["controlKeyword", tags.controlKeyword],
  ["definitionKeyword", tags.definitionKeyword],
  ["moduleKeyword", tags.moduleKeyword],
  ["string", tags.string],
  ["number", tags.number],
  ["integer", tags.integer],
  ["typeName", tags.typeName],
  ["className", tags.className],
  ["namespace", tags.namespace],
  ["function(variableName)", tags.function(tags.variableName)],
  ["variableName", tags.variableName],
  ["definition(variableName)", tags.definition(tags.variableName)],
  ["labelName", tags.labelName],
  ["propertyName", tags.propertyName],
  ["operator", tags.operator],
  ["punctuation", tags.punctuation],
  ["bracket", tags.bracket],
  ["tagName", tags.tagName],
  ["attributeName", tags.attributeName],
  ["constant(variableName)", tags.constant(tags.variableName)],
  ["regexp", tags.regexp],
  ["escape", tags.escape],
  ["bool", tags.bool],
  ["null", tags.null],
  ["atom", tags.atom],
  ["meta", tags.meta],
];

/** Emitted by `@codemirror/lang-markdown`. The regression these tests exist for. */
const PROSE_TAGS: Array<[string, Tag]> = [
  ["heading", tags.heading],
  ["heading1", tags.heading1],
  ["heading3", tags.heading3],
  ["strong", tags.strong],
  ["emphasis", tags.emphasis],
  ["strikethrough", tags.strikethrough],
  ["link", tags.link],
  ["url", tags.url],
  ["monospace", tags.monospace],
  ["quote", tags.quote],
  ["list", tags.list],
  ["processingInstruction", tags.processingInstruction],
  ["contentSeparator", tags.contentSeparator],
];

describe("buildHighlightStyle", () => {
  describe.each(EDITOR_THEMES.map((t) => [t.id, t] as const))("%s", (_id, theme) => {
    const style = buildHighlightStyle(theme);

    it.each(CODE_TAGS)("styles the %s tag", (_label, tag) => {
      expect(style.style([tag])).toBeTruthy();
    });

    it.each(PROSE_TAGS)("styles the Markdown %s tag", (_label, tag) => {
      expect(style.style([tag])).toBeTruthy();
    });
  });

  it("leaves a tag nothing claims unstyled, rather than coloring everything", () => {
    // The counter-check: if `style()` answered for any tag at all, the
    // assertions above would prove nothing. `inserted` belongs to the diff
    // grammar, which the editor never loads.
    const style = buildHighlightStyle(EDITOR_THEMES[0]);
    expect(style.style([tags.inserted])).toBeNull();
  });

  it("gives headings and comments different styles in the default theme", () => {
    // Both used to land on the same flat foreground in Markdown.
    const style = buildHighlightStyle(EDITOR_THEMES[0]);
    expect(style.style([tags.heading])).not.toBe(style.style([tags.comment]));
  });
});
