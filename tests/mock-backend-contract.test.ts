// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { baseFixtureMaps, baseHandlers } from "@/dev/mock-backend/scenarios/base";
import { scenarios } from "@/dev/mock-backend/scenarios";

/**
 * Guards the dev-only browser mock backend (`src/dev/mock-backend/`) against
 * the Rust it stands in for.
 *
 * `tests/ipc-contract.test.ts` already checks that every `invoke("name")` in
 * the app names a real command. The mock is the third side of that triangle
 * and nothing was watching it: its answers are keyed by command name in a
 * plain object, so a command Rust renamed or deleted leaves a fake behind that
 * is never called again. Nothing fails — the fixture just stops being reached,
 * and the screen it was there to populate quietly goes back to empty. That is
 * the exact failure the mock exists to prevent, so it should not be the mock's
 * own failure mode.
 *
 * What this does NOT check is the shape of an answer. The fixtures are typed
 * with the frontend's own API types, so `bun run typecheck` catches a fixture
 * that drifts from the TypeScript — but those types are hand-written mirrors
 * of the Rust structs, not generated from them, so Rust can change its
 * serialisation and both TypeScript sides stay wrong together. Closing that
 * hop means generated bindings (`ts-rs` / `tauri-specta`) and is deliberately
 * not attempted here; see the note in `ipc-contract.test.ts` on the same
 * trade-off.
 *
 * Imports the handler maps rather than parsing them, so a fixture that builds
 * its keys any way it likes is still counted.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = path.join(REPO_ROOT, "src-tauri", "src");
const LIB_RS = path.join(RUST_SRC, "lib.rs");

/**
 * Commands deliberately answered by more than one base fixture map (or by a
 * map and an inline entry in `base.ts`), each with the reason. Object spread
 * makes the LAST definition win silently, so any other overlap is a fake that
 * reads as live and is never reached — which is how `misc`'s phantom
 * `agents_list_running` came to outrank `fake-agent`'s. Keep this short.
 */
const ALLOWED_OVERLAPS: Record<string, string> = {};

/**
 * A vacuous pass is the thing to fear: if the imports below ever resolve to an
 * empty object, every assertion here passes while guarding nothing. Well under
 * the real count (~300 at the time of writing) — a smoke alarm, not a target.
 */
const MIN_MOCKED = 200;

/**
 * Commands Tauri routes itself, which have no `#[tauri::command]` anywhere in
 * `src-tauri/src`. The mock answers them because the plugins are not loaded in
 * a plain browser.
 */
const PLUGIN_PREFIX = "plugin:";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".rs")) out.push(full);
  }
  return out;
}

/**
 * Every `#[tauri::command]` handler name. Same parse as
 * `ipc-contract.test.ts`: the attribute must start its own line (a module doc
 * comment citing it would otherwise name the next unrelated `fn`), and the
 * name is taken from the next `fn` rather than by fixed lookahead, so stacked
 * attributes do not hide a handler.
 */
function declaredCommands(): Set<string> {
  const found = new Set<string>();
  const attribute = /^[ \t]*#\[tauri::command(\([^)]*\))?\]/gm;
  for (const file of walk(RUST_SRC)) {
    const src = readFileSync(file, "utf8");
    for (const attr of src.matchAll(attribute)) {
      const match = src.slice(attr.index + attr[0].length).match(/\bfn\s+([a-z_][a-z0-9_]*)/i);
      if (match) found.add(match[1]);
    }
  }
  return found;
}

/**
 * Command names in `tauri::generate_handler![...]`. Declaring a
 * `#[tauri::command]` is not enough for the real app to answer it; a fake for
 * a declared-but-unregistered command makes the browser work where the app
 * says "command not found". Same bracket-depth scan as `ipc-contract.test.ts`.
 */
function registeredCommands(): Set<string> {
  const src = readFileSync(LIB_RS, "utf8");
  const start = src.indexOf("generate_handler![");
  if (start === -1) throw new Error("no generate_handler! block found in lib.rs");
  const open = src.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("unterminated generate_handler! block in lib.rs");
  return new Set(
    src
      .slice(open + 1, end)
      .split(",")
      .map((entry) => entry.replace(/\/\/.*$/gm, "").trim())
      .filter(Boolean)
      .map((entry) => entry.split("::").pop()!),
  );
}

/**
 * Which base sources define each command: every fixture map that has the key,
 * plus `base.ts (inline)` when the winning value is none of those maps' — i.e.
 * an entry written directly in the `baseHandlers` literal.
 */
function baseOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [name, handler] of Object.entries(baseHandlers)) {
    const from = Object.entries(baseFixtureMaps)
      .filter(([, map]) => Object.prototype.hasOwnProperty.call(map, name))
      .map(([source]) => source);
    const fromMap = Object.values(baseFixtureMaps).some((map) => map[name] === handler);
    owners.set(name, fromMap ? from : [...from, "base.ts (inline)"]);
  }
  return owners;
}

/** Every command name the mock answers, base plus every scenario's overrides. */
function mockedCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (name: string, where: string) => found.set(name, [...(found.get(name) ?? []), where]);

  for (const name of Object.keys(baseHandlers)) add(name, "scenarios/base.ts");
  for (const scenario of Object.values(scenarios)) {
    for (const name of Object.keys({ ...scenario.rawCommands, ...scenario.commands })) {
      add(name, `scenario "${scenario.name}"`);
    }
  }
  return found;
}

describe("browser mock backend contract", () => {
  const declared = declaredCommands();
  const registered = registeredCommands();
  const mocked = mockedCommands();

  // First, so a broken import reports itself as a broken import rather than as
  // a confusing "0 commands differ" pass.
  it("loads a plausible number of mocked commands", () => {
    expect(declared.size).toBeGreaterThan(250);
    expect(registered.size).toBeGreaterThan(250);
    expect(mocked.size).toBeGreaterThan(MIN_MOCKED);
    expect(Object.keys(baseFixtureMaps).length).toBeGreaterThan(10);
  });

  it("answers no command that Rust does not declare", () => {
    const orphaned = [...mocked.entries()]
      .filter(([name]) => !name.startsWith(PLUGIN_PREFIX) && !declared.has(name))
      .map(([name, where]) => `${name} (faked in ${[...new Set(where)].join(", ")})`);

    // A fake with no command behind it is dead weight that reads as coverage:
    // the badge counts it as answered, so the surface it belonged to looks
    // checked when the real app can no longer reach it at all.
    expect(orphaned).toEqual([]);
  });

  it("answers no command that Rust declares but does not register", () => {
    const unregistered = [...mocked.entries()]
      .filter(([name]) => !name.startsWith(PLUGIN_PREFIX) && declared.has(name))
      .filter(([name]) => !registered.has(name))
      .map(([name, where]) => `${name} (faked in ${[...new Set(where)].join(", ")})`);

    // The real app rejects these with "command not found"; the browser mock
    // answering them hides exactly that.
    expect(unregistered).toEqual([]);
  });

  it("no two base fixtures answer the same command unless allowed", () => {
    const overlaps = [...baseOwners().entries()]
      .filter(([name, from]) => from.length > 1 && !(name in ALLOWED_OVERLAPS))
      .map(([name, from]) => `${name} (defined in ${from.join(", ")})`);

    // Every extra definition but the last is dead: nothing ever reaches it.
    expect(overlaps).toEqual([]);

    const stale = Object.keys(ALLOWED_OVERLAPS).filter(
      (name) => (baseOwners().get(name)?.length ?? 0) < 2,
    );
    expect(stale, "ALLOWED_OVERLAPS entries that no longer overlap").toEqual([]);
  });

  it("the catch-all never wins a command a domain fixture also answers", () => {
    // `base.ts` promises that `misc` is outranked by every domain file; object
    // spread only keeps that promise if misc is spread first.
    const misc = baseFixtureMaps["fixtures/misc"];
    const winsWrongly = Object.keys(misc).filter(
      (name) => (baseOwners().get(name)?.length ?? 0) > 1 && baseHandlers[name] === misc[name],
    );
    expect(winsWrongly).toEqual([]);
  });
});
