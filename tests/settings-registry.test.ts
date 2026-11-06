import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUTPUTS, configComment, readSource, staleOutputs } from "../scripts/generate-settings.mjs";
import {
  DEFAULT_SETTINGS,
  SETTINGS_PAGES,
  SETTINGS_REGISTRY,
} from "../src/features/settings/lib/settings-registry.gen";
import { DEFAULT_SCALE, MAX_SCALE, MIN_SCALE } from "../src/features/settings/lib/ui-scale";
import { DEFAULT_APP_ICON } from "../src/features/settings/lib/app-icons";

/**
 * The settings registry has one source: `src-tauri/settings-registry.toml`.
 *
 * Before it, every key was described four times by hand — the Rust doc table
 * that comments a generated `config.toml`, the TS `AppSettings` interface and
 * its `DEFAULT_SETTINGS`, and the schema table in
 * `docs/reference/configuration.md` — and nothing compiled differently when
 * they disagreed. They did: a Light mode still documented as "hidden until
 * QA" after it shipped, five legacy keys described as working, a docs claim
 * that no key needs a restart.
 *
 * `bun run settings:gen` now writes every one of those from the registry.
 * This suite fails the moment a generated file stops matching it; the Rust
 * test `the_settings_registry_matches_app_settings` does the same for the one
 * copy that stays hand-written, the `AppSettings` struct. Between them,
 * neither side can drift.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
const source = readSource();

describe("the generated settings registry", () => {
  it("has a source that describes every key", () => {
    // Floor guard: an empty parse would make every assertion below vacuous.
    expect(source.settings.length).toBeGreaterThan(40);
    for (const setting of source.settings) {
      expect(setting.summary, setting.key).toMatch(/\.$/);
      expect(setting.doc.length, setting.key).toBeGreaterThan(10);
    }
  });

  /**
   * The failure this suite exists for. `bun run settings:gen` fixes it; the
   * message names the files rather than making you bisect four diffs.
   */
  it("has no generated file that has drifted from src-tauri/settings-registry.toml", () => {
    const stale = staleOutputs().map((entry) => entry.path);
    expect(stale, "run `bun run settings:gen`").toEqual([]);
  });

  it("carries every key, in registry order, into each output", () => {
    const keys = source.settings.map((setting) => setting.key);
    expect(Object.keys(DEFAULT_SETTINGS)).toEqual(keys);
    expect(SETTINGS_REGISTRY.map((meta) => meta.key)).toEqual(keys);
    const rust = read(OUTPUTS.rust);
    const docs = read(OUTPUTS.docs);
    for (const setting of source.settings) {
      expect(rust, setting.key).toContain(`"${setting.key}"`);
      expect(docs, setting.key).toContain(`\`${setting.key}\``);
    }
  });

  it("puts every setting on a page the Settings sidebar lists", () => {
    const pages = new Set(SETTINGS_PAGES.map((page) => page.id));
    for (const meta of SETTINGS_REGISTRY) expect(pages.has(meta.page), meta.key).toBe(true);
  });

  /**
   * Defaults that the frontend also names elsewhere. Each pair used to be a
   * silent agreement between two files.
   */
  it("agrees with the frontend's own constants", () => {
    expect(DEFAULT_SETTINGS.uiScale).toBe(DEFAULT_SCALE);
    const uiScale = SETTINGS_REGISTRY.find((meta) => meta.key === "uiScale");
    expect([uiScale?.min, uiScale?.max]).toEqual([MIN_SCALE, MAX_SCALE]);
    expect(DEFAULT_SETTINGS.appIcon).toBe(DEFAULT_APP_ICON);
  });

  it("states each key's default in its config.toml comment", () => {
    for (const setting of source.settings) {
      const comment = configComment(setting);
      for (const line of comment.split("\n")) {
        expect(line, setting.key).toMatch(/^# /);
        expect(line.length, `${setting.key}: ${line}`).toBeLessThanOrEqual(78);
      }
      if (setting.default !== undefined) {
        expect(comment.replace(/\n# /g, " "), setting.key).toContain("(default: ");
      }
    }
  });

  it("rejects a registry entry that would generate something wrong", () => {
    const base = read("src-tauri/settings-registry.toml");
    const broken = base.replace(
      'key = "uiScale"\ntype = "number"',
      'key = "uiScale"\ntype = "float"',
    );
    expect(() => readSource(broken)).toThrow(/unknown type `float`/);
    const restated = base.replace(
      'doc = "Show dotfiles and dot-directories in the explorer file tree."',
      'doc = "Show dotfiles. (default: true)"',
    );
    expect(() => readSource(restated)).toThrow(/restates its default/);
  });
});
