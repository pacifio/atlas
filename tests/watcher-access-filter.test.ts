import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every file watcher in the app drops `EventKind::Access` before doing any
 * work (`src-tauri/src/fs_events.rs`).
 *
 * On Linux, notify's inotify backend reports every *read* of a watched path
 * as an event; FSEvents on macOS never does. A watcher whose callback reads
 * something to interpret an event — `.gitignore`, `.git/index`,
 * `config.toml` — therefore wakes itself and every other watcher on the tree,
 * and an idle project burns most of a core. Nothing in the toolchain can see
 * that: it compiles, every test passes on the Mac, and CI's Linux jobs never
 * sit at an idle desktop. So this suite requires the filter by name at every
 * site that creates a watcher in `src-tauri`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src-tauri", "src");

/** Any of these creates a watcher whose callback must filter. */
const WATCHER_CTOR = /\bnew_debouncer(_opt)?\b|\brecommended_watcher\b|RecommendedWatcher::new\b/;
const FILTER_USE = /\bfs_events::(changes|any_change|is_change)\b/;

function rustFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rustFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

describe("file watchers drop Access events", () => {
  const files = rustFiles(SRC).filter((p) => p !== path.join(SRC, "fs_events.rs"));
  const watcherFiles = files.filter((p) => WATCHER_CTOR.test(readFileSync(p, "utf8")));

  it("finds the watchers it guards", () => {
    // If this goes to zero the regex drifted from the code, not the other way.
    expect(watcherFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of watcherFiles) {
    it(`${path.relative(REPO_ROOT, file)} filters through fs_events`, () => {
      expect(readFileSync(file, "utf8")).toMatch(FILTER_USE);
    });
  }

  it("the filter is what it says: Access, and only Access, is dropped", () => {
    const src = readFileSync(path.join(SRC, "fs_events.rs"), "utf8");
    expect(src).toMatch(/!matches!\(kind, EventKind::Access\(_\)\)/);
  });
});
