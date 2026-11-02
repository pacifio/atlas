import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No `group-has-[…]` / `peer-has-[…]`.
 *
 * Tailwind compiles `group-has-[X]:util` to
 * `.util:is(:where(.group):has(X) *)` — "ANY element below a group that holds
 * an X". Chrome cannot tell which elements such a rule might now match, so
 * whenever something that could be an X changes (a node inserted, focus
 * moving, an attribute flipping) it restyles the whole subtree of every
 * ancestor in reach — in practice the whole app.
 *
 * Measured, not supposed: with any one of these rules in the stylesheet,
 * opening a comment thread's popover cost a ~60ms recalc of all ~6,900
 * elements of a 60-turn chat (twice per jump from the comments popup), and
 * every other popover in the app paid it too. With none, 0ms. It grows with
 * the DOM, so a long real session pays far more. Nothing else in the toolchain
 * notices: the class type-checks, lints, and renders exactly as intended.
 *
 * The cheap form names its target: put `:has()` on the group element and say
 * which descendant it styles — `[&:has(:focus-visible)>[data-x]]:opacity-0`
 * compiles to `.c:has(:focus-visible) > [data-x]`. A plain `has-[X]:util`
 * (the element styled is the one with `:has`) is also fine.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = /\b(?:group|peer)-has-[[\w]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe("ancestor :has() ratchet", () => {
  it("src/ uses no group-has-[…] or peer-has-[…] variant", () => {
    const hits: string[] = [];
    for (const file of walk(path.join(REPO_ROOT, "src"))) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (BANNED.test(line)) {
            hits.push(`${path.relative(REPO_ROOT, file).split(path.sep).join("/")}:${i + 1}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it("the pattern catches what it is meant to", () => {
    expect(BANNED.test('"group-has-[:focus-visible]/row:opacity-0"')).toBe(true);
    expect(BANNED.test("peer-has-checked:block")).toBe(true);
    expect(BANNED.test("has-[:focus-visible]:opacity-100")).toBe(false);
    expect(BANNED.test("[&:has(:focus-visible)>[data-x]]:opacity-0")).toBe(false);
  });
});
