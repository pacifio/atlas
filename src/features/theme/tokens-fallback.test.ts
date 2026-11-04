import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";
import { resolveTheme } from "./resolve-theme";
import { DERIVED_VAR_REGISTRY, THEME_KEY_REGISTRY } from "./theme-key-registry";

/**
 * `tokens.css` carries every theme-key variable at its Atlas-dark value, as
 * the floor under everything else.
 *
 * It used to define only the base tokens, so any frame without a resolved
 * theme — a first run before the first `applyTheme`, or a session where both
 * the chosen theme and the Atlas fallback failed to load — had no theme-key
 * variable at all, and every surface that paints with one came out
 * transparent. The launch cache (`index.html`) covers every later start; this
 * block covers the ones it cannot.
 *
 * The block is GENERATED, from the same registry and the same resolver the
 * app uses, so it cannot drift from what Atlas-dark actually resolves to. This
 * suite fails when it has; to rewrite it:
 *
 *   ATLAS_WRITE_TOKENS=1 bunx vitest run src/features/theme/tokens-fallback.test.ts
 */

const TOKENS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../styles/tokens.css",
);
const BEGIN = "/* generated:atlas-dark-fallback";
const END = "/* /generated:atlas-dark-fallback */";

/** The theme keys and derived variables; the base tokens live above the block. */
const KEY_VARS = new Set<string>(
  [...THEME_KEY_REGISTRY, ...DERIVED_VAR_REGISTRY].map(({ cssVar }) => cssVar),
);

function expectedBlock(): string {
  const atlas = BUILTIN_THEMES.find((theme) => theme.id === "atlas")!;
  const resolved = resolveTheme(atlas, "dark");
  const lines = Object.entries(resolved.cssVars)
    .filter(([name]) => KEY_VARS.has(name))
    .map(([name, value]) => `  ${name}: ${value};`);
  return [
    `${BEGIN} — do not edit.`,
    "   Every theme-key variable at its Atlas-dark value: the floor for a frame",
    "   with no resolved theme. Rewritten by",
    "   `ATLAS_WRITE_TOKENS=1 bunx vitest run src/features/theme/tokens-fallback.test.ts`. */",
    ":root {",
    ...lines,
    "}",
    END,
  ].join("\n");
}

function currentBlock(css: string): string | null {
  const begin = css.indexOf(BEGIN);
  const end = css.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return css.slice(begin, end + END.length);
}

describe("the Atlas-dark fallback in tokens.css", () => {
  if (process.env.ATLAS_WRITE_TOKENS) {
    const css = readFileSync(TOKENS, "utf8");
    const current = currentBlock(css);
    const next = current
      ? css.replace(current, expectedBlock())
      : `${css.trimEnd()}\n\n${expectedBlock()}\n`;
    writeFileSync(TOKENS, next);
  }

  const css = readFileSync(TOKENS, "utf8");

  it("matches what Atlas-dark resolves to", () => {
    expect(currentBlock(css), "run the command in this file's docblock").toBe(expectedBlock());
  });

  it("covers every theme key and every derived variable", () => {
    const block = currentBlock(css) ?? "";
    for (const { cssVar } of [...THEME_KEY_REGISTRY, ...DERIVED_VAR_REGISTRY]) {
      expect(block, cssVar).toContain(`  ${cssVar}: `);
    }
  });
});
