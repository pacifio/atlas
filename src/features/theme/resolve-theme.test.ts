import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseColor, resolveBase, resolveTheme, THEME_KEY_REGISTRY } from "@tryatlas/design/theme";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";

/**
 * The resolver is `@tryatlas/design/theme`'s, and the package tests it against
 * its own TOML. What only desktop can check is the seam: the themes as RUST
 * parses and serialises them, handed to the package's resolver, and the
 * resolver of the INSTALLED build (a release tag carries a built `dist/`)
 * agreeing with the golden fixture desktop's Rust interpreter runs.
 */
describe("the package resolver, on desktop's inputs", () => {
  it.each(
    BUILTIN_THEMES.flatMap((theme) =>
      (["dark", "light"] as const).map(
        (appearance) => [`${theme.id}/${appearance}`, theme, appearance] as const,
      ),
    ),
  )("resolves every key for %s as Rust serialises it", (_name, theme, appearance) => {
    const resolved = resolveTheme(theme, appearance);

    expect(Object.keys(resolved.keys)).toHaveLength(THEME_KEY_REGISTRY.length);
    for (const [key, value] of Object.entries(resolved.keys)) {
      expect(parseColor(value), `${theme.id}/${appearance}: ${key} = ${value}`).not.toBeNull();
    }
  });

  /**
   * The fixture `crates/atlas-theme/tests/base_derivation.rs` also reproduces:
   * two interpreters of one engine, held to one answer. It is a copy of the
   * package's (`bun run theme:keys`); to change a rule, change the package.
   */
  it("matches the golden fixture Rust's interpreter runs", () => {
    const fixturePath = path.join(
      import.meta.dirname,
      "../../../crates/atlas-theme/tests/fixtures/base-derivation.json",
    );
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as DerivationCase[];
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      expect(resolveBase(entry.written, entry.palette, entry.appearance), entry.name).toEqual(
        entry.base,
      );
    }
  });
});

interface DerivationCase {
  name: string;
  appearance: "dark" | "light";
  written: Record<string, string>;
  palette: Record<string, string>;
  base: Record<string, string>;
}
