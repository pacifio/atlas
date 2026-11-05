/**
 * Writes the Atlas theme's syntax colours from `@pierre/theme`, the palette
 * Pierre's diffs use.
 *
 * Each of Pierre's two VS Code themes goes through Atlas's own VS Code
 * importer (the `syntax_from_vscode` example in `crates/atlas-theme`), so the
 * scopes map onto Atlas's fifteen syntax roles exactly as they would for a
 * theme a user imports. The result replaces the marked block in each variant
 * of `themes/atlas.toml`, and becomes the last-resort `dark`/`light` default
 * of each `syntax.*` key in `keys.toml` — what a theme that sets neither the
 * key nor its palette or base source gets. Pierre's LICENSE and NOTICE are
 * copied beside desktop's copy of the theme.
 *
 * Both files belong to `@tryatlas/design` (ADR-0027), and desktop only holds
 * copies, so this writes into a checkout of the package. The importer is Rust
 * and lives here, which is why the script does too. To take a new Pierre
 * release:
 *
 *   bun update @pierre/theme
 *   bun run theme:pierre <path to a tryatlas/design checkout>
 *   (in the checkout) bun run theme, commit, release a tag
 *   (here) bump the pin, bun install, bun run theme:keys
 *
 * `tests/pierre-syntax.test.ts` fails while the installed version and the one
 * the block names differ.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pierre = join(root, "node_modules", "@pierre", "theme");
const design = process.argv[2] ? resolve(process.argv[2]) : null;
if (!design || !existsSync(join(design, "keys.toml"))) {
  console.error("usage: bun run theme:pierre <path to a tryatlas/design checkout>");
  process.exit(1);
}
const target = join(design, "themes", "atlas.toml");
const keysToml = join(design, "keys.toml");
const thirdParty = join(root, "crates", "atlas-theme", "third-party", "pierre-theme");

const { version } = JSON.parse(readFileSync(join(pierre, "package.json"), "utf8"));

/** The marker lines, shared with the test that checks them. */
export const begin = (variant) =>
  `# BEGIN syntax from @pierre/theme ${version} (pierre-${variant}), written by \`bun run theme:pierre\``;
export const END = "# END syntax from @pierre/theme";

function syntaxLines(variant) {
  return execFileSync(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "atlas-theme",
      "--example",
      "syntax_from_vscode",
      "--",
      join(pierre, "themes", `pierre-${variant}.json`),
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
}

let toml = readFileSync(target, "utf8");
let keys = readFileSync(keysToml, "utf8");
for (const variant of ["dark", "light"]) {
  const lines = syntaxLines(variant);
  const block = new RegExp(
    `# BEGIN syntax from @pierre/theme [^\\n]*\\(pierre-${variant}\\)[^\\n]*\\n[\\s\\S]*?${END}`,
  );
  if (!block.test(toml)) throw new Error(`atlas.toml has no Pierre block for ${variant}`);
  toml = toml.replace(block, `${begin(variant)}\n${lines}\n${END}`);

  // `"syntax.keyword" = "#ff678d"` → that key's `dark = …` / `light = …`.
  for (const [, key, value] of lines.matchAll(/^"(syntax\.[a-z_]+)" = "([^"]+)"$/gm)) {
    const entry = new RegExp(
      `(name = "${key.replace(".", "\\.")}"\\n(?:(?!\\[\\[)[^\\n]*\\n)*?${variant} = )"[^"]*"`,
    );
    if (!entry.test(keys)) throw new Error(`keys.toml has no ${variant} default for ${key}`);
    keys = keys.replace(entry, `$1"${value}"`);
  }
}
writeFileSync(target, toml);
writeFileSync(keysToml, keys);

mkdirSync(thirdParty, { recursive: true });
for (const file of ["LICENSE", "NOTICE.md"])
  copyFileSync(join(pierre, file), join(thirdParty, file));
console.log(
  `${target} syntax now from @pierre/theme ${version}. Run \`bun run theme\` there, release, ` +
    "then bump the pin here and run `bun run theme:keys`.",
);
