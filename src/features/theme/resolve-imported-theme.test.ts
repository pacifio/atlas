import { describe, expect, it } from "vitest";
import importedThemes from "@/dev/mock-backend/fixtures/imported-themes.json";
import { parseColor, resolveTheme, THEME_KEY_REGISTRY, type Theme } from "@tryatlas/design/theme";

/**
 * The end of the import path.
 *
 * `crates/atlas-theme/tests/import.rs` proves the converted TOML parses and
 * carries every required base token, but "parses" is not the bar an imported
 * theme has to clear — the bar is that the TypeScript resolver produces EVERY
 * theme key in the registry from it, with a real colour in each. The count is
 * `THEME_KEY_REGISTRY.length` and moves with `keys.toml`; do not restate it. Those are two different
 * checks separated by a language boundary, and only one of them can be run in
 * Rust.
 *
 * So the Rust suite writes `imported-themes.json` (a snapshot it also asserts
 * is current) and this suite resolves it, exactly as the app would. A mapping
 * change in Rust that leaves a key resolving to an empty string fails here.
 *
 * The fixtures behind the snapshot: a tweakcn Catppuccin registry item, both
 * members of a Zed family, and a VS Code theme with an `include`.
 */

// Through `unknown`: see the same cast in `fixtures/theme-import.ts`.
const themes = importedThemes as unknown as Theme[];

describe("an imported theme resolves like any other", () => {
  it("covers all three importers", () => {
    expect(themes.map((theme) => theme.id)).toEqual([
      "catppuccin",
      "rose-pine",
      "rose-pine-dawn",
      "nocturne-bright",
    ]);
  });

  it.each(
    themes.flatMap((theme) =>
      (["dark", "light"] as const).map(
        (appearance) => [`${theme.id}/${appearance}`, theme, appearance] as const,
      ),
    ),
  )("resolves every key for %s", (label, theme, appearance) => {
    const resolved = resolveTheme(theme, appearance);

    expect(Object.keys(resolved.keys)).toHaveLength(THEME_KEY_REGISTRY.length);
    for (const [key, value] of Object.entries(resolved.keys)) {
      expect(value, `${label}: ${key} is empty`).not.toBe("");
      expect(parseColor(value), `${label}: ${key} = ${value}`).not.toBeNull();
    }
  });

  it("keeps the author's own colour notation rather than converting it", () => {
    const catppuccin = themes.find((theme) => theme.id === "catppuccin");
    expect(catppuccin?.dark?.base.background).toMatch(/^oklch\(/);
    // Zed writes 8-digit hex; the importer does not shorten or re-encode it.
    const rosePine = themes.find((theme) => theme.id === "rose-pine");
    expect(rosePine?.dark?.keys["terminal.ansi.red"]).toMatch(/^#[0-9a-f]{8}$/);
  });
});
