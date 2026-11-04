import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSITION_ALL_RULE, formatViolations, runRatchet } from "@tryatlas/design/ratchet";
import { DERIVED_VAR_REGISTRY, THEME_KEY_REGISTRY } from "@tryatlas/design/theme";

/**
 * The design-system ratchet (decision 33) — closed at zero.
 *
 * Foundations put the type, radius, elevation, z-index and motion scales in
 * Tailwind namespaces, but the 2026-09-17 audit found the app almost entirely
 * off them: 95% of 1,427 font-size utilities were arbitrary, nearly every
 * floating layer sat at a hand-written 9999–100000, there were 686 colour
 * literals in 141 files, and 56 inline `zIndex` values. None of that compiles
 * differently, so nothing else in the toolchain can see it — a new
 * `text-[11.5px]` type-checks, lints, renders, and is invisible until someone
 * re-reads the file.
 *
 * The sweep finished with every count at zero, so this is a ban: a new
 * violation fails, full stop. The rules and the runner are
 * `@tryatlas/design/ratchet` (ADR-0027), so desktop, web and docs hold one set;
 * the exemptions are desktop's, below. A failure lists every site and what to
 * write instead.
 *
 * That only works because the exits are real ones. A value that genuinely
 * cannot come from the scale gets `EXEMPT_FILES` (a whole file that DEFINES
 * the scale, or whose colours are not Atlas's to choose) or an inline
 * `ratchet-allow: <reason>` marker at the site — in a comment on the line or
 * anywhere in the comment block above it, with a reason of 20+ characters.
 * Both demand prose, and both are checked. If you are reaching for one, read
 * what the existing entries argue before adding another — "it has a lot of
 * them" is not one of the arguments.
 *
 * Scope is every folder that renders: `src/features`, `src/components` and
 * `src/dev`. The primitives are the package's and are held to the same rules
 * there. `src/styles` is the only exclusion — it IS the scale, so "use the
 * scale instead" cannot apply to it. `src/dev` keeps a narrow exemption for
 * the fixture files whose CONTENT is colours (theme files, fake source
 * listings) — see `EXEMPT_DIRS`.
 *
 * One rule looks wider. `transition-all` (and `transition: all`) animates
 * whatever changes next — a width, a padding that follows a count — so each
 * use is a layout animation recalculating the page every frame, and that is
 * as true in `src/styles` and `index.html` as anywhere. The package's rule is
 * passed back with its scope widened to all of `src/` plus `index.html`, in
 * a run of its own that the colour exemptions below do not reach.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["src/features", "src/components", "src/dev"];
const TRANSITION_ALL_SCOPE = ["src", "index.html"];

/**
 * Whole files inside the scanned roots that are exempt, each with the reason.
 * `src/styles` is not scanned because it DEFINES these values; the entries
 * below are in a feature folder for a different reason each time, and the
 * reason is the entry — a path with no argument next to it is not an
 * exemption, it is a number someone gave up on. `runRatchet` fails an entry
 * whose reason is under 40 characters, whose path is gone, or that no longer
 * suppresses anything.
 *
 * Two shapes qualify and nothing else does:
 *
 *  1. **The file defines the scale.** "Use a theme key instead" cannot apply to
 *     the table a theme key resolves through.
 *  2. **The colour is not Atlas's to choose.** A third party's brand mark, a
 *     palette the USER picks a value from, or a colour that has to survive
 *     being shown over content Atlas did not draw. A theme key that could
 *     restate any of those would be a theme lying about someone else's colour.
 *
 * "It has a lot of them" is not a reason. For a single site inside an ordinary
 * file, use the inline marker below instead — it keeps the rest of the file
 * scanned.
 */
const EXEMPT_FILES: Record<string, string> = {
  "src/features/agents/lib/agent-brand.ts":
    "Shape 2. The first-party agents' OWN brand colours — the one kind of " +
    "colour a theme key must not be able to restate (ADR-0002, and the " +
    "2026-09-18 key-set audit that deleted the eighteen `agent.*` keys).",
  "src/components/agent-icons.tsx":
    "Shape 2. The vendors' logo marks, drawn as inline SVG. Same argument as " +
    "`agent-brand.ts`: a recoloured logo is the wrong logo.",
  "src/components/agent-icons.test.tsx": "Shape 2. Asserts the marks above are drawn as shipped.",
  "src/features/external-editor/components/editor-icons.tsx":
    "Shape 2. The editors' logo marks (VS Code's blues, VSCodium's gradient) " +
    'beside "Open in <editor>". Same argument as `agent-icons.tsx`: ' +
    "a recoloured logo is the wrong logo.",
  "src/features/knowledge/components/cover-picker.tsx":
    "Shape 2. The page-cover palette the user picks from. These are document " +
    "content, like a highlighter colour — the chrome around the picker is themed.",
  "src/features/spaces/lib/space-wire.ts":
    "Shape 2. The sticky-note and shape palette a user picks from on a space, " +
    "and the wire format those choices persist in. Theming them would repaint " +
    "other people's notes.",
  "src/features/spaces/lib/space-wire.test.ts": "Shape 2. Fixtures for the palette above.",
  "src/features/pdf/stores/pdf-annotation-store.ts":
    "Shape 2. Highlighter and ink colours the user picks and that are written " +
    "into the annotation, i.e. into the document.",
  "src/features/pdf/components/pdf-toolbar.tsx":
    "Shape 2. Renders the swatches for the ink colours above; the swatch has " +
    "to be the colour it applies.",
  "src/features/terminal/lib/line-emulator.ts":
    "Not a colour: it BUILDS `rgb(r,g,b)` strings out of the numeric " +
    "parameters of an ANSI escape sequence. The rule matches the format, not a " +
    "choice anyone made.",
  "src/dev/mock-backend/badge.ts":
    "Shape 2, of a kind: the unmocked-command counter, injected into the DOM " +
    "by the dev mock backend. It has to stay legible over whatever theme is " +
    "being tested, INCLUDING a broken one, which is the situation it reports.",
};

/**
 * Whole DIRECTORIES that are exempt. Same bar as `EXEMPT_FILES`, and there is
 * exactly one shape that qualifies: a file whose COLOURS ARE ITS CONTENT.
 *
 * `src/dev` as a whole is NOT exempt — it renders, it is where every visual
 * check happens, and the gallery is the surface the scales are judged on. But
 * the mock fixtures are theme files and fake source listings: a fake `.tsx`
 * with `bg-red-500` in it is a string the editor renders as text, not a class
 * anything applies, and a built-in theme's JSON is 1,274 colour literals by
 * construction.
 */
const EXEMPT_DIRS: Record<string, string> = {
  "src/dev/mock-backend/fixtures":
    "The colours ARE the fixture: built-in and imported theme files (a theme " +
    "is nothing but literals), and the text of fake source files the editor " +
    "and diff surfaces render as content rather than apply as classes.",
};

describe("design-system ratchet", () => {
  it("has no violation in " + SCAN_ROOTS.join(" + "), () => {
    const violations = runRatchet({
      cwd: REPO_ROOT,
      roots: SCAN_ROOTS,
      exemptFiles: EXEMPT_FILES,
      exemptDirs: EXEMPT_DIRS,
    });
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  // Its own run, without the exemptions above: those argue a file's COLOURS,
  // and must not wave a `transition-all` through. No roots, so only the
  // scoped rule scans; a per-site `ratchet-allow` is still honoured.
  it("has no transition-all in " + TRANSITION_ALL_SCOPE.join(" + "), () => {
    // A scoped path that is gone scans nothing and passes silently.
    for (const scoped of TRANSITION_ALL_SCOPE) {
      expect(existsSync(path.join(REPO_ROOT, scoped)), scoped).toBe(true);
    }
    const violations = runRatchet({
      cwd: REPO_ROOT,
      roots: [],
      rules: [{ ...TRANSITION_ALL_RULE, scope: TRANSITION_ALL_SCOPE }],
    });
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Theme keys lost their `--atlas-` prefix (ADR-0027): `element.hover` is
 * `--element-hover`, and the old spelling is not aliased. A `var()` naming the
 * old one resolves to nothing and paints transparent, which nothing else in
 * the toolchain reports, so the old spellings are banned outright, across all
 * of `src/` and `index.html`, with no `ratchet-allow` exit. App variables that
 * are not theme keys (`--atlas-chat-column`, `--atlas-boot-*`, the font
 * settings) keep their prefix and are not matched.
 */
describe("retired `--atlas-` theme-key names", () => {
  it("are named nowhere", () => {
    const names = [...THEME_KEY_REGISTRY, ...DERIVED_VAR_REGISTRY]
      .map(({ cssVar }) => cssVar.slice(2))
      .sort((a, b) => b.length - a.length);
    const retired = new RegExp(`--atlas-(?:${names.join("|")})(?![\\w-])`, "g");
    const files = [...walk(path.join(REPO_ROOT, "src")), path.join(REPO_ROOT, "index.html")];
    const hits = files.flatMap((file) =>
      (readFileSync(file, "utf8").match(retired) ?? []).map(
        (name) => `${path.relative(REPO_ROOT, file)}: ${name}`,
      ),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(hits, "drop the `--atlas-` prefix: a theme key's variable is `--<key>`").toEqual([]);
  });
});
