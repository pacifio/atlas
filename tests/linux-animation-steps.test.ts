import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every infinite animation in `globals.css` has a stepped Linux override.
 *
 * WebKitGTK presents a full-window frame for every tick of an accelerated
 * animation, and Atlas's UI process pays for each one: a 14 px spinner that
 * never stops measured 40% of a core on an idle project on Linux. macOS
 * composites the same spinner for nothing, so nothing on a Mac — no test, no
 * profiler, no reviewer — can see it. The block at the end of `globals.css`
 * gives each long-running animation a `steps()` timing under
 * `html.platform-linux`, which caps its frame rate; a new infinite
 * animation added without one reintroduces the cost silently. This suite is
 * the only thing that notices.
 *
 * Also pinned: the class the block keys on is set at startup, and the
 * ring whose 3 s turn would drop to 4 fps under the default step count sets
 * its own.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const LINUX = "html.platform-linux";

/** Every `selector { … }` block of a stylesheet, flattened one level. */
function blocks(source: string): { selector: string; body: string }[] {
  // Comments first: the one above a rule would otherwise read as its selector.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  let depth = 0;
  let start = -1;
  let selectorStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const selector = css.slice(selectorStart, start - 1).trim();
        out.push({ selector, body: css.slice(start, i) });
        selectorStart = i + 1;
      }
    }
  }
  return out;
}

describe("infinite animations are stepped on Linux", () => {
  const css = read("src/styles/globals.css");
  const all = blocks(css);
  // Nested blocks (`@media { … }`, `@keyframes { … }`) are flattened out here;
  // the rules that matter are top-level class rules.
  const infinite = all.filter(
    (b) =>
      b.selector.startsWith(".") &&
      /\binfinite\b/.test(b.body) &&
      // A rule that already steps its own animation needs no override.
      !/steps\(/.test(b.body),
  );
  const overrides = new Map(
    all
      .filter((b) => b.selector.startsWith(LINUX))
      .map((b) => [b.selector.slice(LINUX.length).trim(), b.body]),
  );

  it("finds the animations it guards", () => {
    expect(infinite.length).toBeGreaterThanOrEqual(6);
  });

  for (const b of infinite) {
    const name = b.selector.split(",")[0].trim();
    it(`${name} has a Linux steps() override`, () => {
      const body = overrides.get(name);
      expect(body, `no "${LINUX} ${name}" rule in globals.css`).toBeDefined();
      expect(body).toMatch(/animation-timing-function:\s*steps\(/);
    });
  }

  for (const utility of [".animate-spin", ".animate-pulse"]) {
    it(`Tailwind's ${utility} has a Linux steps() override`, () => {
      expect(overrides.get(utility)).toMatch(/animation-timing-function:\s*steps\(/);
    });
  }

  it("the class the overrides key on is set before the first render", () => {
    const main = read("src/main.tsx");
    expect(main).toMatch(/markPlatform\(\);/);
    expect(main.indexOf("markPlatform();")).toBeLessThan(main.indexOf("createRoot("));
    expect(read("src/lib/platform.ts")).toMatch(/classList\.add\(`platform-\$\{name\}`\)/);
  });

  it("the working ring sets its own step count for its 3 s turn", () => {
    const ring = read("src/features/sidebar/components/session-row-parts.tsx");
    expect(ring).toMatch(/\[animation-duration:3s\] \[--atlas-linux-spin-steps:36\]/);
  });
});
