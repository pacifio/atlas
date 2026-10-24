import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `no-unknown-classes` allowlist in `.oxlintrc.json` names only classes
 * that exist.
 *
 * `@shadcn/lint`'s `no-unknown-classes` reports any class Tailwind cannot
 * generate — a typo like `rounded-huge`, or a plugin utility the repo does not
 * ship (`animate-in` was one: a dialog's fade-in that never ran). It knows
 * Tailwind and `@utility`, but not the plain CSS classes in Atlas's own
 * stylesheets (`.atlas-tab`, `.prose-chat`, …), so those are allowlisted.
 *
 * WHY each name is listed exactly rather than as `atlas-*`: a wildcard is the
 * one shape that hides the bug the rule exists for. `atlas-promt` matches
 * `atlas-*`, so a misspelled Atlas class would pass silently — and most of
 * Atlas's custom classes start with `atlas-`.
 *
 * The cost of exact names is drift in the other direction: a class deleted
 * from a stylesheet stays allowlisted, and a later typo that lands on it is
 * waved through. That is what this suite closes. Every allowlisted name must
 * be one of:
 *
 *   - defined as a selector in a stylesheet under `src/` (or an `@utility`);
 *   - a JS hook, matched by `closest()`/`querySelector()` rather than styled,
 *     and still referenced that way in `src/`;
 *   - a class a library itself styles or reads (listed below, with why).
 *
 * Adding a new stylesheet class needs nothing here: the lint error on its
 * first use says to allowlist it. Removing one fails this suite until the
 * allowlist entry goes too.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");

/** Classes matched from script, never styled. Each must still be queried. */
const JS_HOOKS = ["atlas-cmd-suggest", "atlas-mention-picker", "atlas-slash-picker"];

/** Classes a dependency styles or reads; no Atlas stylesheet defines them. */
const LIBRARY_CLASSES: Record<string, string> = {
  nodrag: "@xyflow/react: an element inside a node that must not start a drag",
  hljs: "highlight.js: the root its themes are scoped under",
  lucide: "lucide: the class every lucide-react icon carries, mirrored by a hand-drawn one",
  "lucide-github": "lucide: the per-icon class lucide-react adds, mirrored likewise",
};

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function readAllowlist(): string[] {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".oxlintrc.json"), "utf8"));
  const rule = config.rules?.["shadcn/no-unknown-classes"];
  expect(Array.isArray(rule), "shadcn/no-unknown-classes is configured with options").toBe(true);
  expect(rule[0], "shadcn/no-unknown-classes is an error, not a warning").toBe("error");
  return rule[1].allow as string[];
}

function definedClasses(): Set<string> {
  const defined = new Set<string>();
  for (const file of walk(SRC, [".css"])) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
    for (const m of css.matchAll(/@utility\s+([\w-]+)/g)) defined.add(m[1]);
  }
  return defined;
}

describe("shadcn-lint allowlist", () => {
  const allow = readAllowlist();
  const defined = definedClasses();
  const scripts = walk(SRC, [".ts", ".tsx"]).map((file) => readFileSync(file, "utf8"));

  it("parses a plausible allowlist and stylesheet set", () => {
    // Floors: a parse that stops matching fails here rather than passing vacuously.
    expect(allow.length).toBeGreaterThan(40);
    expect(defined.size).toBeGreaterThan(200);
  });

  it("names every class exactly — no wildcards", () => {
    expect(allow.filter((name) => /[*?[\]]/.test(name))).toEqual([]);
  });

  it("allowlists only classes that exist", () => {
    const unexplained = allow.filter(
      (name) => !defined.has(name) && !JS_HOOKS.includes(name) && !(name in LIBRARY_CLASSES),
    );
    expect(
      unexplained,
      "allowlisted but defined in no stylesheet under src/ — remove it from .oxlintrc.json",
    ).toEqual([]);
  });

  it("keeps each JS hook queried from script", () => {
    for (const hook of JS_HOOKS) {
      expect(allow, `${hook} is allowlisted`).toContain(hook);
      const queried = scripts.some((src) => src.includes(`".${hook}"`));
      expect(queried, `${hook} is no longer queried — drop it from both lists`).toBe(true);
    }
  });

  it("keeps the library classes in the allowlist", () => {
    for (const name of Object.keys(LIBRARY_CLASSES)) expect(allow).toContain(name);
  });
});
