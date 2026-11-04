import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OUTPUTS,
  readSource,
  staleOutputs,
  cssVar,
  keyDescription,
} from "../scripts/generate-theme-keys.mjs";
import {
  BASE_RULE_REGISTRY,
  DERIVED_VAR_REGISTRY,
  THEME_KEY_REGISTRY,
} from "@/features/theme/theme-key-registry";

/**
 * The theme-key registry has one source: `crates/atlas-theme/keys.toml`.
 *
 * The same facts used to live in five files — the TS registry, the Rust key
 * list, the JSON Schema, this repo's reference doc and the public one — each
 * hand-edited. Nothing compiled differently when they disagreed, so they did:
 * a "134 keys" count that was really 135, and a scrollbar rule documented as
 * "alpha/lighten" that is plain alpha, both shipped and both survived review.
 * The count is deliberately not restated here either: it is `keys.toml`'s to
 * know, and the 2026-09-18 audit changed it once already.
 *
 * So this suite is the whole point of the generator. `bun run theme:keys`
 * rewrites every derived file; this fails the build the moment one of them
 * stops matching the source, which is what makes the drift impossible rather
 * than merely noticed.
 *
 * It does NOT re-check the derivation results — `resolve-theme.test.ts` owns
 * that. It checks that the generated copies agree with the source.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const source = readSource();
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

describe("the generated theme-key registry", () => {
  it("has a source with every key described", () => {
    // Floor guard: an empty parse would make every assertion below vacuous.
    expect(source.keys.length).toBeGreaterThan(50);
    for (const key of source.keys) {
      expect(key.description, key.name).toMatch(/\.$/);
      expect(key.palette ?? key.base, `${key.name} has no derivation source`).toBeTruthy();
    }
  });

  /**
   * The failure this suite exists for. `bun run theme:keys` fixes it; the
   * message names the files rather than making you bisect four diffs.
   */
  it("has no generated file that has drifted from crates/atlas-theme/keys.toml", () => {
    const stale = staleOutputs().map((entry) => entry.path);
    expect(stale, "run `bun run theme:keys`").toEqual([]);
  });

  it("names every key in each generated file", () => {
    const registry = read(OUTPUTS.registry);
    const keyList = read(OUTPUTS.keyList);
    const docs = read(OUTPUTS.docs);
    const schemaKeys = JSON.parse(read(OUTPUTS.schema)).definitions.ThemeVariant.properties.keys;

    for (const key of source.keys) {
      expect(registry, key.name).toContain(`define("${key.name}", {`);
      expect(keyList, key.name).toContain(`\n${key.name}\t`);
      expect(docs, key.name).toContain(`| \`${key.name}\` |`);
      expect(schemaKeys.properties[key.name]?.description).toBe(keyDescription(key));
    }
    expect(Object.keys(schemaKeys.properties)).toHaveLength(source.keys.length);
  });

  /**
   * An open `keys` map validates nothing, so `#:schema` used to accept a
   * misspelled role name and the author's colour silently never appeared.
   */
  it("closes the key set in the schema so an author's typo is an error", () => {
    const schemaKeys = JSON.parse(read(OUTPUTS.schema)).definitions.ThemeVariant.properties.keys;
    expect(schemaKeys.additionalProperties).toBe(false);
    expect(schemaKeys.properties["syntax.keyword"].allOf).toEqual([
      { $ref: "#/definitions/ThemeKeyValue" },
    ]);
    expect(schemaKeys.properties["syntax.keywrod"]).toBeUndefined();
  });

  it("warns Rust about exactly the keys the frontend resolves", () => {
    const fromRust = read(OUTPUTS.keyList)
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split("\t")[0]);
    expect(fromRust).toEqual(source.keys.map((key) => key.name));
  });

  /** The CSS variable name is the contract with every `var(--…)` call. */
  it("keeps the CSS variable spelling of every key", () => {
    const registry = read(OUTPUTS.registry);
    for (const key of source.keys) {
      expect(cssVar(key.name)).toBe(`--${key.name.replaceAll(".", "-").replaceAll("_", "-")}`);
    }
    expect(registry).toContain('cssVar: `--${key.replaceAll(".", "-").replaceAll("_", "-")}`');
  });

  /**
   * Keys carry no prefix (ADR-0027), so `.` and `_` both becoming `-` is the
   * whole mapping, and it shares one `:root` namespace with the derived
   * variables, the shadcn base tokens and Tailwind's `@theme`. Two names on one
   * variable is invisible at runtime: the later write wins and the other
   * consumer paints the wrong colour. The generator refuses such a source too;
   * this holds the generated registry to it.
   */
  it("maps every key to a CSS variable nothing else uses", () => {
    const owners = new Map<string, string[]>();
    const claim = (variable: string, owner: string) =>
      owners.set(variable, [...(owners.get(variable) ?? []), owner]);

    for (const rule of BASE_RULE_REGISTRY) claim(`--${rule.token}`, `base.${rule.token}`);
    for (const font of ["font-sans", "font-serif", "font-mono"]) claim(`--${font}`, `base.${font}`);
    // Every variable a Tailwind `@theme` block declares: a key landing on one
    // would be read as that namespace's value (`--text-*` is a font size).
    const globals = read("src/styles/globals.css");
    for (const start of [...globals.matchAll(/@theme\b[^{]*\{/g)].map((m) => m.index!)) {
      let depth = 0;
      let end = globals.indexOf("{", start);
      do {
        if (globals[end] === "{") depth++;
        if (globals[end] === "}") depth--;
        end++;
      } while (depth > 0);
      for (const [, variable] of globals.slice(start, end).matchAll(/(--[\w-]+)\s*:/g)) {
        if (!owners.get(variable)?.includes("@theme")) claim(variable, "@theme");
      }
    }
    for (const definition of THEME_KEY_REGISTRY) claim(definition.cssVar, definition.key);
    for (const definition of DERIVED_VAR_REGISTRY) claim(definition.cssVar, definition.name);

    const keyVars = [
      ...THEME_KEY_REGISTRY.map((definition) => definition.cssVar),
      ...DERIVED_VAR_REGISTRY.map((definition) => definition.cssVar),
    ];
    // Floor guard, so an empty registry cannot pass vacuously.
    expect(keyVars.length).toBe(source.keys.length + source.derived.length);
    for (const variable of keyVars) expect(variable).not.toMatch(/^--atlas-/);
    const collisions = keyVars
      .filter((variable) => owners.get(variable)!.length > 1)
      .map((variable) => `${variable}: ${owners.get(variable)!.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  /**
   * A derived variable is Atlas's, not the author's. If one leaked into
   * `theme-keys.txt` or the schema it would become settable in every editor
   * and every loader, which is the whole thing this split exists to prevent.
   */
  it("keeps derived variables out of the author-facing key set", () => {
    const keyNames = new Set(source.keys.map((key) => key.name));
    const keyList = read(OUTPUTS.keyList);
    const schemaKeys = JSON.parse(read(OUTPUTS.schema)).definitions.ThemeVariant.properties.keys;

    expect(source.derived.length).toBeGreaterThan(0);
    for (const entry of source.derived) {
      expect(keyNames.has(entry.name), `${entry.name} is also a key`).toBe(false);
      expect(keyList).not.toContain(`\n${entry.name}\t`);
      expect(schemaKeys.properties[entry.name]).toBeUndefined();
      // The transform is the point: an untransformed derivation is an alias.
      expect(entry.op, entry.name).toBeTruthy();
      expect(Boolean(entry.from) !== Boolean(entry.base), entry.name).toBe(true);
      if (entry.from)
        expect(keyNames.has(entry.from), `${entry.name} derives from no key`).toBe(true);
      expect(read(OUTPUTS.registry)).toContain(`derive("${entry.name}", {`);
    }
  });

  /**
   * Prose and fixtures name keys too, and nothing compiles them. The
   * 2026-09-18 cut took the set from 135 keys to 73 and left `border.default`,
   * `border.variant`, `comms.mention.background`, `stat.*`, `syntax.builtin`,
   * `syntax.meta`, `syntax.punctuation`, `status.purple` and `status.orange`
   * behind in the import fixture and the import reference — a fixture that
   * teaches the mock backend to report a mapping onto a key that no longer
   * exists, and a document telling a theme author to set one.
   *
   * Scoped to the two places where a dotted name is unambiguously an ATLAS
   * key: a `<variant>.keys.<name>` target in an import-report fixture, and the
   * first column of the reference's scope table, whose header says so. Prose
   * cannot be scanned: `theme-import.md` spends most of its length naming
   * Zed's and VS Code's keys, and Zed's vocabulary overlaps ours almost
   * exactly (`border.variant`, `element.hover`, `syntax.keyword`), so a
   * blanket backtick sweep reports the correct sentences as errors.
   */
  it("names no key that no longer exists, in the docs or the mock fixtures", () => {
    const keyNames = new Set(source.keys.map((key) => key.name));
    const derivedNames = new Set(source.derived.map((entry) => entry.name));
    const known = (name: string) => keyNames.has(name) || derivedNames.has(name);

    const offenders: string[] = [];
    const check = (where: string, text: string, pattern: RegExp) => {
      for (const [, name] of text.matchAll(pattern)) {
        if (!known(name)) offenders.push(`${where}: ${name}`);
      }
    };

    // `dark.keys.foo.bar` / `light.keys.foo.bar` in an import-report fixture.
    const fixture = read("src/dev/mock-backend/fixtures/theme-import.ts");
    check(
      "theme-import.ts",
      fixture,
      /\b(?:dark|light)\.keys\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)/g,
    );

    // "| `syntax.x` |" — the scope table's Atlas-key column.
    check("theme-import.md", read("docs/reference/theme-import.md"), /^\| `(syntax\.[a-z_]+)`/gm);

    expect(offenders.sort()).toEqual([]);
  });

  it("keeps each group's keys contiguous", () => {
    const seen: string[] = [];
    for (const key of source.keys) {
      if (seen[seen.length - 1] !== key.group) {
        expect(seen, `group ${key.group} is split`).not.toContain(key.group);
        seen.push(key.group);
      }
    }
    expect(seen).toEqual(source.groups.map((group) => group.name));
  });
});
