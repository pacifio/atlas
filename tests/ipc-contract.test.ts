import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the Tauri IPC contract: ~350 `#[tauri::command]` handlers on the Rust
 * side against ~316 `invoke("name")` string literals on the TypeScript side.
 *
 * Nothing else in the toolchain can see this seam. `tsc --noEmit` type-checks
 * the *arguments* to `invoke` but the command name is an opaque string, so a
 * renamed Rust command, a typo, or a handler left out of `generate_handler!`
 * all compile clean and fail at runtime — as a rejected promise inside a
 * feature panel, usually reported as "the button does nothing".
 *
 * We parse source text rather than compiling anything. The alternative
 * (`tauri-specta` generated bindings) would be stronger since it also checks
 * argument and return types, but it means a build-time codegen step and a
 * checked-in generated file. This test costs milliseconds and no build.
 *
 * If you add a command, nothing here needs updating — the sets are derived.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SRC = path.join(REPO_ROOT, "src-tauri", "src");
const TS_SRC = path.join(REPO_ROOT, "src");
const LIB_RS = path.join(RUST_SRC, "lib.rs");

/**
 * Floors that make a vacuous pass impossible.
 *
 * The failure mode this defends against: someone reformats `lib.rs`, a regex
 * below stops matching, every derived set comes back empty, and the equality
 * assertions pass trivially — leaving a green test that guards nothing,
 * possibly for years. These numbers are deliberately well under the real
 * counts at the time of writing (350 declared / 345 registered / 316 invoked);
 * they are a smoke alarm for "the parser broke", not a coverage target, so
 * they should only ever be raised if a parser rewrite needs a tighter alarm.
 */
const MIN_DECLARED = 250;
const MIN_REGISTERED = 250;
const MIN_INVOKED = 200;

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `target/` holds vendored dependency sources — walking it would pull in
    // every `#[tauri::command]` in every crate we depend on.
    if (entry.name === "target" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Command handlers as *declared*: every `fn` carrying `#[tauri::command]`.
 *
 * The attribute must start its own line. `skills.rs` cites `#[tauri::command]`
 * inside a `//!` module doc comment, and matching that occurrence sent the
 * scan past it to the next unrelated `fn` (an `impl Default`), inventing a
 * command called `default`.
 *
 * Taking the *next* `fn` after the attribute, rather than one regex spanning
 * both, tolerates additional attributes stacked between the two — a
 * fixed-lookahead pattern would silently skip those handlers.
 */
function declaredCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const attribute = /^[ \t]*#\[tauri::command\]/gm;
  for (const file of walk(RUST_SRC, [".rs"])) {
    const src = readFileSync(file, "utf8");
    for (const attr of src.matchAll(attribute)) {
      const match = src
        .slice(attr.index + attr[0].length)
        .match(/\bfn\s+([a-z_][a-z0-9_]*)/i);
      if (!match) continue;
      const name = match[1];
      const where = path.relative(REPO_ROOT, file);
      found.set(name, [...(found.get(name) ?? []), where]);
    }
  }
  return found;
}

/** Command handlers as *registered* in `tauri::generate_handler![...]`. */
function registeredCommands(): string[] {
  const src = readFileSync(LIB_RS, "utf8");
  const start = src.indexOf("generate_handler![");
  if (start === -1) throw new Error("no generate_handler! block found in lib.rs");

  // Scan bracket depth from the macro's `[` so a nested `[...]` inside the
  // list can never end the block early.
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

  return src
    .slice(open + 1, end)
    .split(",")
    .map((entry) => entry.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop()!);
}

/**
 * Command names the frontend calls as string literals.
 *
 * Comment lines are skipped for the same reason as on the Rust side: prose
 * citing a command name should not be able to assert that it exists.
 */
function invokedCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /\binvoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
  for (const file of walk(TS_SRC, [".ts", ".tsx"])) {
    const where = path.relative(REPO_ROOT, file);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const match of line.matchAll(pattern)) {
        const name = match[1];
        found.set(name, [...(found.get(name) ?? []), where]);
      }
    }
  }
  return found;
}

describe("tauri IPC contract", () => {
  const declared = declaredCommands();
  const registered = registeredCommands();
  const invoked = invokedCommands();
  const registeredSet = new Set(registered);

  // These three run first so that a broken parser reports itself as a broken
  // parser, rather than as a confusing "0 commands differ" pass.
  it("parses a plausible number of declared commands", () => {
    expect(declared.size).toBeGreaterThan(MIN_DECLARED);
  });

  it("parses a plausible number of registered commands", () => {
    expect(registered.length).toBeGreaterThan(MIN_REGISTERED);
  });

  it("parses a plausible number of invoked commands", () => {
    expect(invoked.size).toBeGreaterThan(MIN_INVOKED);
  });

  it("registers every command name exactly once", () => {
    // Tauri keys the IPC router on the bare fn name, so two handlers sharing a
    // name in different modules collide however they are namespaced in Rust.
    const duplicates = registered.filter((n, i) => registered.indexOf(n) !== i);
    expect([...new Set(duplicates)]).toEqual([]);

    const collisions = [...declared.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name} declared in ${files.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("every frontend invoke() targets a registered command", () => {
    const missing = [...invoked.entries()]
      .filter(([name]) => !registeredSet.has(name))
      .map(([name, files]) => `invoke("${name}") in ${files.join(", ")}`);

    // Fails when a Rust command is renamed or deleted without updating its
    // callers, and when a call site has a typo.
    expect(missing).toEqual([]);
  });

  it("every #[tauri::command] is registered in generate_handler!", () => {
    const unregistered = [...declared.keys()]
      .filter((name) => !registeredSet.has(name))
      .map((name) => `${name} (${declared.get(name)!.join(", ")})`);

    // An unregistered handler is dead code that looks live: the fn compiles,
    // clippy is happy, and the frontend gets "command not found" at runtime.
    expect(unregistered).toEqual([]);
  });

  it("registers no command that has no #[tauri::command] handler", () => {
    // The reverse drift: an entry left in `generate_handler!` after its
    // handler was deleted. This one at least fails the Rust build, so it is
    // here for a clear message rather than for detection.
    const orphaned = registered.filter((name) => !declared.has(name));
    expect(orphaned).toEqual([]);
  });
});
