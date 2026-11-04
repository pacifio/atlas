import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageCopies, packageRoot, strayThemes } from "../scripts/generate-theme-keys.mjs";

/**
 * Desktop's copies of the theme engine's data match the installed
 * `@tryatlas/design`, byte for byte.
 *
 * The package owns `keys.toml`, the built-in themes, the Rust rule tables and
 * the golden fixture (ADR-0027). Desktop's Rust build must stay hermetic —
 * cargo never reads `node_modules` — so `bun run theme:keys` copies them into
 * `crates/atlas-theme/`, where `include_str!` compiles them in. Nothing in
 * cargo or `tsc` can see a copy fall behind the package: bump the pin without
 * re-running the copy and the frontend resolves themes with the new rules
 * while Rust imports and exports with the old ones, and every gate stays
 * green. This suite is the only thing that notices.
 *
 * Fix: `bun run theme:keys`. Never edit a copy; change the package.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop's copies of @tryatlas/design's theme data", () => {
  const copies = packageCopies();

  it("covers keys.toml, the themes, both rule tables and the golden fixture", () => {
    const targets = copies.map(([, to]) => to);
    expect(targets).toContain("crates/atlas-theme/keys.toml");
    expect(targets).toContain("crates/atlas-theme/theme-keys.txt");
    expect(targets).toContain("crates/atlas-theme/base-rules.txt");
    expect(targets).toContain("crates/atlas-theme/tests/fixtures/base-derivation.json");
    // Floor guard: an empty `themes/` listing would pass every check below.
    expect(
      targets.filter((to) => to.startsWith("crates/atlas-theme/themes/")).length,
    ).toBeGreaterThan(0);
  });

  it.each(copies)("%s is copied verbatim to %s", (from, to) => {
    const expected = readFileSync(path.join(packageRoot(), from), "utf8");
    const committed = readFileSync(path.join(REPO_ROOT, to), "utf8");
    expect(
      committed === expected,
      `${to} differs from the package; run \`bun run theme:keys\``,
    ).toBe(true);
  });

  it("ships no theme the package dropped", () => {
    expect(strayThemes(), "delete these: the package no longer ships them").toEqual([]);
  });
});
