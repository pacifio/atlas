import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";
import { previewTheme } from "./preview-theme";
import { resolveTheme, type Theme } from "@tryatlas/design/theme";

const themes = BUILTIN_THEMES;
const withBoth = themes.find((theme) => theme.dark && theme.light)!;

/** A theme that sets almost nothing — an import, or a half-written file. */
function sparse(id: string): Theme {
  return {
    schema: 1,
    id,
    name: id,
    author: "test",
    license: "MIT",
    dark: { base: {}, palette: {}, keys: {} },
  };
}

describe("previewTheme", () => {
  it("resolves the same values applyTheme would", () => {
    const preview = previewTheme(withBoth, "light");
    const resolved = resolveTheme(withBoth, "light");
    expect(preview.appearance).toBe("light");
    expect(preview.vars["--syntax-keyword"]).toBe(resolved.keys["syntax.keyword"]);
    expect(preview.vars["--background"]).toBe(resolved.base.background);
  });

  it("answers the identical object for a repeated (theme, appearance)", () => {
    // What keeps a search keystroke from re-resolving every card.
    expect(previewTheme(withBoth, "dark")).toBe(previewTheme(withBoth, "dark"));
    expect(previewTheme(withBoth, "light")).not.toBe(previewTheme(withBoth, "dark"));
  });

  it("re-resolves a theme that was read again", () => {
    // The cache is keyed on the object, so the store dropping `loaded` after
    // the file watcher fires is all the invalidation there is.
    const reread = structuredClone(withBoth);
    expect(previewTheme(reread, "dark")).not.toBe(previewTheme(withBoth, "dark"));
  });

  it("reports the variant it actually used, not the one asked for", () => {
    const darkOnly = sparse("dark-only");
    expect(previewTheme(darkOnly, "light").appearance).toBe("dark");
  });

  it("previews a theme with no base tokens at all", () => {
    // Every base token is derived (ADR-0022), so nothing inside a preview can
    // inherit the ACTIVE theme's colours from `:root`.
    const preview = previewTheme(sparse("empty"), "dark");
    for (const value of Object.values(preview.swatch)) {
      expect(value).toMatch(/^#|^rgb|^hsl|^oklch/);
    }
    for (const token of ["--border", "--muted-foreground", "--sidebar", "--ring"] as const) {
      expect(preview.vars[token], token).toBeTruthy();
    }
    expect(preview.vars["--background"]).toBe(preview.vars["--editor-background"]);
  });

  it("leaves a theme's own base tokens alone", () => {
    // ratchet-allow: a fixture theme's own colours. Checking that a value
    // comes back unchanged means handing the resolver a value first, and no
    // theme key can stand in for one a test invents.
    const own = { background: "#010203", foreground: "#fefefe" };
    const themed = sparse("themed");
    themed.dark!.base = { ...own };
    const preview = previewTheme(themed, "dark");
    expect(preview.swatch.background).toBe(own.background);
    expect(preview.swatch.foreground).toBe(own.foreground);
  });
});
