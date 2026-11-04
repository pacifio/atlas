import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";
import { colorToCss, contrastRatio, parseColor } from "./color";
import { resolveBase, resolveTheme } from "./resolve-theme";
import { THEME_KEY_REGISTRY } from "./theme-key-registry";
import type { Theme } from "./lib/theme-api";

const themes = BUILTIN_THEMES;

describe("theme resolution", () => {
  it.each(
    themes.flatMap((theme) =>
      (["dark", "light"] as const).map(
        (appearance) => [`${theme.id}/${appearance}`, theme, appearance] as const,
      ),
    ),
  )("resolves every key for %s", (_name, theme, appearance) => {
    const resolved = resolveTheme(theme, appearance);

    expect(Object.keys(resolved.keys)).toHaveLength(THEME_KEY_REGISTRY.length);
    for (const [key, value] of Object.entries(resolved.keys)) {
      expect(parseColor(value), `${theme.id}/${appearance}: ${key} = ${value}`).not.toBeNull();
    }
  });

  it("applies base, palette, and key overrides after the theme", () => {
    const resolved = resolveTheme(themes[0], "dark", {
      base: { foreground: "#123456" },
      palette: { red: "#654321" },
      keys: { "syntax.keyword": "#abcdef" },
    });

    expect(resolved.base.foreground).toBe("#123456");
    expect(resolved.keys["terminal.ansi.red"]).toBe("#654321");
    expect(resolved.keys["syntax.keyword"]).toBe("#abcdef");
  });
});

describe("interface contrast", () => {
  const atlas = themes.find((theme) => theme.id === "atlas")!;
  /** Distance between two colours, summed over channels. */
  const distance = (a: string, b: string) => {
    const [x, y] = [parseColor(a)!, parseColor(b)!];
    return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b);
  };

  it("leaves the theme as written at 100%", () => {
    expect(resolveTheme(atlas, "dark", {}, 100)).toEqual(resolveTheme(atlas, "dark"));
  });

  it("moves borders toward the text above 100% and toward the background below", () => {
    const plain = resolveTheme(atlas, "dark");
    const high = resolveTheme(atlas, "dark", {}, 200);
    const low = resolveTheme(atlas, "dark", {}, 50);
    const { foreground, background } = plain.base;

    expect(distance(high.keys["border.strong"], foreground)).toBeLessThan(
      distance(plain.keys["border.strong"], foreground),
    );
    expect(distance(low.keys["border.strong"], background)).toBeLessThan(
      distance(plain.keys["border.strong"], background),
    );
    // The CSS and the typed record agree, so xterm and the charts see it too.
    expect(high.cssVars["--border-strong"]).toBe(high.keys["border.strong"]);
    expect(high.cssVars["--border"]).toBe(high.base.border);
  });
});

describe("hsl()", () => {
  const css = (value: string) => colorToCss(parseColor(value)!);
  it("keeps every channel for a hue past 240°, and wraps a hue outside 0–360", () => {
    expect(css("hsl(0 100% 50%)")).toBe("#ff0000");
    expect(css("hsl(300 100% 50%)")).toBe("#ff00ff");
    expect(css("hsl(-60 100% 50%)")).toBe("#ff00ff");
    expect(css("hsl(660 100% 50%)")).toBe("#ff00ff");
  });
});

describe("base derivation (ADR-0022)", () => {
  it("fills every base token from two seeds", () => {
    const seeds = { background: "#101418", primary: "#7aa2f7" };
    const base = resolveBase(seeds, {}, "dark");
    for (const token of BASE_TOKENS_OF_ATLAS) expect(base[token], token).toBeTruthy();
    expect(base.ring).toBe("#7aa2f7");
    expect(base["chart-1"]).toBe("#7aa2f7");
    // Text on the primary fill is whichever of the theme's own two inks reads.
    expect(contrastRatio(base.primary, base["primary-foreground"])).toBeGreaterThan(4.5);
  });

  it("gives a background with no foreground whichever ink reads on it", () => {
    // A light background in a dark variant: white, the dark default, would not read.
    const base = resolveBase({ background: "#f5f0e6" }, {}, "dark");
    expect(base.foreground).toBe("#000000");
  });

  it("never touches a written token and lets the palette feed the charts", () => {
    const base = resolveBase({ card: "#222222" }, { green: "#00ff00" }, "dark");
    expect(base.card).toBe("#222222");
    expect(base["chart-2"]).toBe("#00ff00");
  });

  it("resolves a theme whose variant names only its seeds", () => {
    const theme = {
      id: "seeds",
      name: "Seeds",
      dark: { base: { background: "#101418", primary: "#7aa2f7" }, palette: {}, keys: {} },
    } as unknown as Theme;
    const resolved = resolveTheme(theme, "dark");
    expect(resolved.cssVars["--border"]).toBe(resolved.base.border);
    expect(resolved.keys["editor.background"]).toBe("#101418");
  });

  /**
   * The fixture Rust's interpreter (`crates/atlas-theme/tests/base_derivation.rs`)
   * also reproduces: two implementations of one engine, held to one answer.
   * To change a rule on purpose, regenerate it here and commit the diff:
   * `ATLAS_WRITE_DERIVATION=1 bunx vitest run src/features/theme/resolve-theme.test.ts`.
   */
  it("matches the golden fixture both interpreters share", () => {
    const fixturePath = path.join(
      __dirname,
      "../../../crates/atlas-theme/tests/fixtures/base-derivation.json",
    );
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as DerivationCase[];
    const derived = cases.map((entry) => ({
      ...entry,
      base: resolveBase(entry.written, entry.palette, entry.appearance),
    }));
    if (process.env.ATLAS_WRITE_DERIVATION === "1") {
      writeFileSync(fixturePath, `${JSON.stringify(derived, null, 2)}\n`);
    }
    for (const [index, entry] of derived.entries()) {
      expect(entry.base, entry.name).toEqual(cases[index].base);
    }
  });
});

interface DerivationCase {
  name: string;
  appearance: "dark" | "light";
  written: Record<string, string>;
  palette: Record<string, string>;
  base?: Record<string, string>;
}

const BASE_TOKENS_OF_ATLAS = [
  "background",
  "foreground",
  "card",
  "popover",
  "primary",
  "primary-foreground",
  "secondary",
  "muted-foreground",
  "accent",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-5",
  "sidebar",
  "sidebar-border",
  "radius",
  "shadow-2xl",
];
