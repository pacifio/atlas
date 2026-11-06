import { describe, expect, it } from "vitest";
import { stripNextSteps } from "./next-steps";

/** The previous implementation, verbatim, as the oracle. */
function stripOld(content: string): string {
  let out = content;
  const dir = out.indexOf("\n\n═══ Atlas next-steps ═══");
  if (dir >= 0) out = out.slice(0, dir);
  const tag = out.toLowerCase().lastIndexOf("<next_step");
  if (tag >= 0) out = out.slice(0, tag);
  return out.replace(/\s+$/, "");
}

const CASES = [
  "plain prose with no tag at all",
  "answer\n\n<next_steps>\n- do a thing\n- do another\n</next_steps>",
  "answer\n\n<NEXT_STEPS>\n- upper case\n</NEXT_STEPS>",
  "answer\n\n<Next_Step",
  "answer with a partial <next_step",
  "math a < b and c > d, no tag",
  "generic <div> and <span> markup, no tag",
  "two blocks <next_steps>one</next_steps> then <next_steps>two</next_steps>",
  "trailing whitespace   \n\n\t ",
  "",
  "<next_steps> at the very start",
  "a <nextstep> near-miss and a <next_stepX> near-miss",
  "unicode ✨ before <next_steps>\n- x\n</next_steps>",
  "tag-like <NeXt_StEp mixed case",
  // `<` as the very first character, not the tag. `lastIndexOf("<", -1)` is
  // `lastIndexOf("<", 0)`, so a scan that stepped to `at - 1` found index 0
  // again forever — a message starting with HTML hung the renderer.
  "<div>only</div>",
  "<",
  "<<<",
  "<p>para</p>\n\n<next_steps>\n- x\n</next_steps>",
];

/**
 * `stripNextSteps` runs on the streaming tail on every animation frame, so it
 * was rewritten to find its tag without lower-casing a copy of the whole
 * answer. These pin it to the behaviour of the implementation it replaced.
 */
describe("stripNextSteps", () => {
  it("matches the previous implementation on every case", () => {
    for (const c of CASES) expect(stripNextSteps(c), JSON.stringify(c)).toBe(stripOld(c));
  });

  it("matches on every prefix of a streaming answer", () => {
    const doc =
      "Here is the answer.\n\nIt has <angle> brackets and a < comparison.\n\n<next_steps>\n- first follow-up\n- second follow-up\n</next_steps>";
    for (let i = 0; i <= doc.length; i++) {
      const p = doc.slice(0, i);
      expect(stripNextSteps(p), `prefix ${i}`).toBe(stripOld(p));
    }
  });
});
