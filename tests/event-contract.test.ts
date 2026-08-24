import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the Tauri *event* seam, the way `ipc-contract.test.ts` guards the
 * command seam: every `listen("atlas:…")` on the TypeScript side must have a
 * producer — an `"atlas:…"` literal on the Rust side (emit sites and the
 * consts they read from) or a TS-side `emit("atlas:…")`.
 *
 * Nothing else in the toolchain can see this seam either. Event names are
 * opaque strings to both compilers, so deleting a Rust module that owned an
 * emitter leaves its TS listeners compiling clean and waiting forever — the
 * feature quietly stops updating. That exact class of break was possible
 * during the 2026-08-22 module removals (memory-chat's model events died with
 * `memory_chat.rs`); this test makes the next one loud.
 *
 * Window `CustomEvent`s (`dispatchEvent`/`addEventListener`) are TS↔TS and
 * type-checked routes exist for neither side, but they never cross the IPC
 * boundary — they are out of scope here on purpose.
 *
 * If you add an event, nothing here needs updating — the sets are derived.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS_SRC = path.join(REPO_ROOT, "src");
const RUST_ROOTS = [path.join(REPO_ROOT, "src-tauri", "src"), path.join(REPO_ROOT, "crates")];

/**
 * Floors that make a vacuous pass impossible: if a refactor breaks the
 * extraction regexes, the derived sets collapse and the subset assertion
 * passes trivially. These are well under the real counts at the time of
 * writing (32 listened / 58+ produced) — a smoke alarm for "the parser
 * broke", not a coverage target.
 */
const MIN_LISTENED = 15;
const MIN_PRODUCED = 30;

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Events the frontend subscribes to via Tauri `listen`/`once`. The name may
 *  sit a line or two after the call (formatting), so the window after the
 *  call site is searched rather than demanding one exact shape. */
function listenedEvents(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const call = /\b(?:listen|once)\s*(?:<[^;]*?>)?\s*\(/g;
  for (const file of walk(TS_SRC, [".ts", ".tsx"])) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(call)) {
      const window = src.slice(m.index, m.index + 200);
      const name = window.match(/"(atlas:[a-z0-9:_-]+)"/);
      if (!name) continue;
      const where = path.relative(REPO_ROOT, file);
      found.set(name[1], [...(found.get(name[1]) ?? []), where]);
    }
  }
  return found;
}

/** Every `"atlas:…"` literal a producer could emit under: all Rust literals
 *  (emit sites + the consts they're built from) plus TS-side Tauri emits. */
function producedEvents(): Set<string> {
  const out = new Set<string>();
  const literal = /"(atlas:[a-z0-9:_-]+)"/g;
  for (const root of RUST_ROOTS) {
    for (const file of walk(root, [".rs"])) {
      for (const m of readFileSync(file, "utf8").matchAll(literal)) out.add(m[1]);
    }
  }
  const emitCall = /\bemit\s*\(\s*"(atlas:[a-z0-9:_-]+)"/g;
  for (const file of walk(TS_SRC, [".ts", ".tsx"])) {
    for (const m of readFileSync(file, "utf8").matchAll(emitCall)) out.add(m[1]);
  }
  return out;
}

describe("tauri event contract", () => {
  const listened = listenedEvents();
  const produced = producedEvents();

  it("extracted enough of both sides to be meaningful", () => {
    expect(listened.size).toBeGreaterThanOrEqual(MIN_LISTENED);
    expect(produced.size).toBeGreaterThanOrEqual(MIN_PRODUCED);
  });

  it("every listened event has a producer", () => {
    const orphans = [...listened.entries()]
      .filter(([name]) => {
        if (produced.has(name)) return false;
        // Prefixed families: Rust builds names like `atlas:model-download:progress`
        // from a base + suffix in `format!`; a literal prefix match covers them.
        return ![...produced].some((p) => name.startsWith(`${p}:`) || p.startsWith(`${name}:`));
      })
      .map(([name, files]) => `${name} (listened in ${files.join(", ")})`);
    expect(orphans).toEqual([]);
  });
});
