import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Atlas theme's syntax colours are Pierre's (`@pierre/theme`), written
 * into `@tryatlas/design`'s `atlas.toml` and `keys.toml` by `bun run
 * theme:pierre <design checkout>` through Atlas's own VS Code importer, and
 * copied back here by `bun run theme:keys` once the package is released and
 * the pin bumped. The dependency is desktop's; the TOML is derived and
 * committed, because Rust compiles the built-in themes in and cannot read
 * `node_modules`.
 *
 * What fails silently without this: bumping `@pierre/theme` and forgetting
 * the script. Nothing errors — the app keeps the old colours and the lockfile
 * claims the new ones. So the version each generated block names must be the
 * version installed, and Pierre's licence and notice must sit beside it.
 *
 * The same script writes Pierre's colours as each `syntax.*` key's
 * last-resort default in `keys.toml`, so a theme with no syntax of its own
 * gets the same code colours as the Atlas theme. A hand edit to either copy
 * would split them without a sound; the two must agree.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const toml = readFileSync(path.join(root, "crates/atlas-theme/themes/atlas.toml"), "utf8");
const keysToml = readFileSync(path.join(root, "crates/atlas-theme/keys.toml"), "utf8");
const installed = JSON.parse(
  readFileSync(path.join(root, "node_modules/@pierre/theme/package.json"), "utf8"),
).version as string;

describe("Atlas theme syntax colours come from @pierre/theme", () => {
  for (const variant of ["dark", "light"]) {
    it(`the ${variant} block names the installed version`, () => {
      const match = toml.match(
        new RegExp(`# BEGIN syntax from @pierre/theme (\\S+) \\(pierre-${variant}\\)`),
      );
      expect(match, `atlas.toml has no generated ${variant} block`).not.toBeNull();
      expect(
        match?.[1],
        "run `bun run theme:pierre <design checkout>`, release the package and bump its pin",
      ).toBe(installed);
    });

    it(`keys.toml's ${variant} syntax defaults are the ${variant} block`, () => {
      const block = toml.match(
        new RegExp(`\\(pierre-${variant}\\)[^\\n]*\\n([\\s\\S]*?)# END syntax from @pierre/theme`),
      )?.[1];
      const written = [...(block ?? "").matchAll(/^"(syntax\.[a-z_]+)" = "([^"]+)"$/gm)];
      expect(written.length).toBeGreaterThan(0);
      for (const [, key, value] of written) {
        const entry = keysToml.match(
          new RegExp(
            `name = "${key.replace(".", "\\.")}"\\n(?:(?!\\[\\[)[^\\n]*\\n)*?${variant} = "([^"]*)"`,
          ),
        );
        expect(entry?.[1], `${key} — run \`bun run theme:pierre\``).toBe(value);
      }
    });
  }

  it("carries Pierre's licence and notice", () => {
    for (const file of ["LICENSE", "NOTICE.md"]) {
      expect(existsSync(path.join(root, "crates/atlas-theme/third-party/pierre-theme", file))).toBe(
        true,
      );
    }
  });
});
