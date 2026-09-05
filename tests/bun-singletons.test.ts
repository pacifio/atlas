import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every package that must exist exactly once in `node_modules` does.
 *
 * WHY this needs a test at all — three facts that compound:
 *
 *   1. **`bun update` leaves duplicates behind.** It rewrites the caret ranges
 *      in `package.json` to whatever it resolved and re-resolves the ROOT
 *      requirement, but keeps the already-installed nested copy for every other
 *      requirer. One measured run left `@codemirror/language` 6.12.4 at the
 *      root and 6.12.3 nested under TWELVE packages (every `lang-*`,
 *      `autocomplete`, …), plus nine nested `prosemirror-model` and five nested
 *      `prosemirror-view`.
 *   2. **Only a clean reinstall fixes it.** bun has no `dedupe` command;
 *      `bun update <pkg>` reports "no changes" and `rm bun.lock && bun install`
 *      still leaves the nested copies. `rm -rf node_modules bun.lock &&
 *      bun install` is the one sequence that collapses them.
 *   3. **`resolve.dedupe` in `vite.config.ts` only MASKS it.** It makes the
 *      production bundle ship one copy, so the build stays green while the tree
 *      is wrong — and it covers only the packages listed in it. On that same
 *      duplicated tree, a build WITHOUT `dedupe` defined `defineLanguageFacet`
 *      in 12 chunks; `prosemirror-model`, which is not in the list, shipped
 *      twice either way and broke `tsc` outright (`Node` from one copy not
 *      assignable to `Node` from the other).
 *
 * The visible symptoms are ugly and hard to trace back: an editor theme
 * registered against copy A's `StyleModule` while the `EditorView` comes from
 * copy B (text renders unstyled), `instanceof` checks failing between two
 * ProseMirror document models, two React copies fighting over hook state.
 *
 * So this suite asserts the tree itself, not the bundle. It is what fires on
 * the tree `bun update` leaves behind, before `resolve.dedupe` has to save
 * anything.
 *
 * `pdfjs-dist` additionally has to MATCH react-pdf's pin: `pdf-viewer.tsx`
 * takes the worker from the root copy and the API from react-pdf's re-export,
 * and pdfjs refuses at runtime when the two versions differ. react-pdf pins it
 * exactly, so the root entry in `package.json` is exact too — a caret there is
 * what lets `bun update` drift them apart.
 *
 * Same approach as the other suites here: read what the repo actually declares
 * (the `dedupe` list is parsed out of `vite.config.ts` rather than duplicated),
 * with floor assertions so a parse that stops matching fails loudly instead of
 * passing vacuously.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const VITE_CONFIG = path.join(REPO_ROOT, "vite.config.ts");

/**
 * The nine CodeMirror/Lezer entries `vite.config.ts` dedupes, as declared
 * there. Read rather than copied: the list and this guard must not drift, and
 * the assertion below is what says so.
 */
const EXPECTED_DEDUPE = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/language",
  "@codemirror/commands",
  "@codemirror/search",
  "@codemirror/autocomplete",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  "pdfjs-dist",
];

/**
 * Packages that must be singletons for reasons the `dedupe` list does not
 * cover. ProseMirror is the cautionary case (see the header): it duplicated on
 * the updated tree and `dedupe` did nothing for it, because a package only
 * benefits from `dedupe` if someone remembered to list it. Guarding the tree
 * instead means the list does not have to be complete.
 */
const EXTRA_SINGLETONS = [
  "react",
  "react-dom",
  "prosemirror-model",
  "prosemirror-state",
  "prosemirror-view",
  "prosemirror-transform",
  "@tiptap/core",
  "@tiptap/pm",
  "immer",
];

/** The `resolve.dedupe: [...]` array in `vite.config.ts`. */
function dedupeList(): string[] {
  const src = readFileSync(VITE_CONFIG, "utf8");
  const block = /dedupe:\s*\[([\s\S]*?)\]/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Every `<any node_modules>/<pkg>/package.json` on disk, for the given package
 * names.
 *
 * Descends only into directories actually named `node_modules`, so this walks
 * the nesting bun creates and not the ~100k source files inside each package.
 * `.bin` (symlink farm) and `.cache` are skipped: neither holds packages, and
 * `.bin` entries point back at files this walk already visits.
 */
function copiesOf(names: Set<string>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (nodeModules: string) => {
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const dir = path.join(nodeModules, entry.name);
      if (!statSync(dir).isDirectory()) continue;
      // A scoped directory (`@tiptap`) holds packages; it is not one itself.
      const packages: Array<[string, string]> = entry.name.startsWith("@")
        ? readdirSync(dir, { withFileTypes: true })
            .filter(
              (e) => !e.name.startsWith(".") && statSync(path.join(dir, e.name)).isDirectory(),
            )
            .map((e) => [`${entry.name}/${e.name}`, path.join(dir, e.name)])
        : [[entry.name, dir]];
      for (const [name, packageDir] of packages) {
        if (names.has(name) && existsSync(path.join(packageDir, "package.json"))) {
          found.set(name, [...(found.get(name) ?? []), packageDir]);
        }
        const nested = path.join(packageDir, "node_modules");
        if (existsSync(nested)) walk(nested);
      }
    }
  };
  walk(NODE_MODULES);
  return found;
}

/** `version` of the package installed at `dir`. */
function versionAt(dir: string): string {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
}

/** What react-pdf declares it needs, which is an exact version, not a range. */
function reactPdfPdfjsPin(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(NODE_MODULES, "react-pdf", "package.json"), "utf8"),
  );
  return manifest.dependencies["pdfjs-dist"];
}

describe("node_modules holds one copy of each package that needs one", () => {
  const declared = dedupeList();
  const guarded = [...declared, ...EXTRA_SINGLETONS];
  const copies = copiesOf(new Set(guarded));

  it("parses the dedupe list out of vite.config.ts", () => {
    // Floor guard: an unmatched regex would leave `guarded` covering only the
    // extras and silently stop watching everything the config lists.
    expect(declared).toEqual(EXPECTED_DEDUPE);
  });

  it("finds every guarded package installed", () => {
    const missing = guarded.filter((name) => !copies.has(name));
    expect(missing).toEqual([]);
  });

  it.each(guarded)("has exactly one %s", (name) => {
    const where = (copies.get(name) ?? []).map((dir) => path.relative(REPO_ROOT, dir));
    // More than one means the tree came out of `bun update` rather than a
    // clean install. Fix: `rm -rf node_modules bun.lock && bun install`.
    expect(where).toHaveLength(1);
  });

  it("installs the pdfjs-dist react-pdf pins", () => {
    const [installed] = copies.get("pdfjs-dist") ?? [];
    expect(installed).toBeDefined();
    // react-pdf pins exactly; `package.json` must name that same version with
    // no caret, or the next `bun update` drifts the worker off the API.
    expect(versionAt(installed)).toBe(reactPdfPdfjsPin());
  });

  it("keeps the root pdfjs-dist range exact", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(manifest.dependencies["pdfjs-dist"]).toBe(reactPdfPdfjsPin());
  });
});
