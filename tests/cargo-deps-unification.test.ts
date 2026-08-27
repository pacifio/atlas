import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the two `links=` collisions that block vendoring the Codex engine
 * (issue #39, spec D4 / Phase 0).
 *
 * A crate declaring `links = "foo"` may appear **once** in a dependency graph.
 * Two Atlas dependencies collide with the engine's on exactly that rule:
 *
 *   - `libsqlite3-sys` (`links = "sqlite3"`): the engine needs 0.37 (via
 *     codex-state and sqlx); Atlas resolved 0.30.1 through `rusqlite = "0.32"`,
 *     which hard-wires it. Both sides bundle vendored SQLite, so even a second
 *     copy cargo tolerated would collide on duplicate `sqlite3_*` symbols.
 *   - `tree-sitter` (`links = "tree-sitter"`): the engine was on 0.25,
 *     `atlas-codeindex` on 0.26. Unification is on **0.26** — the engine's side
 *     is bumped when the fork lands (#42); Atlas's side is already there and
 *     this test is what keeps it there.
 *
 * Research: `docs/research/codex-atlas-integration-surface.md` §6, BLOCKER A/B.
 *
 * **Why a text test rather than a compile error:** until the fork is in-tree
 * there is nothing to collide *with*. A regression here — a crate added on
 * rusqlite 0.32, a second tree-sitter major pulled in transitively — compiles
 * perfectly today and only fails much later, in #42, as a link error far from
 * its cause. The failure this file prevents is a diagnosis cost, not a build
 * break, which is exactly the kind cargo will not announce.
 *
 * The companion assertion runs against the *linked* library rather than the
 * lockfile: `crates/atlas-thread-metadata/tests/sqlite_floor.rs`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_LOCK = path.join(REPO_ROOT, "Cargo.lock");

/**
 * The `libsqlite3-sys` major the engine pins (`libsqlite3-sys = "0.37"`,
 * codex-rs/Cargo.toml:362). This is a **pin, not a floor**: `links = "sqlite3"`
 * admits exactly one, so 0.38 collides with the engine just as surely as 0.36
 * does — being *newer* is not being *compatible*. 0.37.0 is also what bundles
 * SQLite past the ≥ 3.51.3 WAL-reset corruption fix; the SQLite version itself
 * is asserted where it can be read for real, in `sqlite_floor.rs`.
 */
const ENGINE_LIBSQLITE3_SYS_MAJOR = "0.37";

/** The major the two sides unify on. `0.26` is a cargo major (0.x). */
const TREE_SITTER_MAJOR = "0.26";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Every `[[package]]` entry in a Cargo.lock, as `name -> versions`. */
function lockPackages(lockFile: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const src = read(lockFile);
  // Stop each block at the next table header of ANY kind. Splitting on
  // `[[package]]` alone would let a trailing `[[patch.unused]]` — plausible
  // here, given the vendored patch entries — ride along inside the last
  // package and be read as part of it. Names and versions are always plain
  // quoted strings in a generated lockfile.
  for (const chunk of src.split(/^\[\[package\]\]$/m).slice(1)) {
    const block = chunk.split(/^\[/m)[0];
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !version) continue;
    out.set(name, [...(out.get(name) ?? []), version]);
  }
  return out;
}

/** `"0.37.0"` -> `"0.37"`, `"1.2.3"` -> `"1"`. Cargo's compatibility unit: for
 *  a 0.x crate the minor is the major. */
function cargoMajor(version: string): string {
  const [a, b] = version.split(".");
  return a === "0" ? `0.${b}` : a;
}

/** Manifests Atlas owns: the workspace root, every crate, and the app. */
function ownedManifests(): string[] {
  const crates = path.join(REPO_ROOT, "crates");
  return [
    path.join(REPO_ROOT, "Cargo.toml"),
    path.join(REPO_ROOT, "src-tauri", "Cargo.toml"),
    ...readdirSync(crates, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(crates, e.name, "Cargo.toml")),
  ].filter((m) => existsSync(m));
}

describe("the sqlite3 links collision", () => {
  const packages = () => lockPackages(ROOT_LOCK);

  it("reads the root lockfile (parser health)", () => {
    // A regex that stopped matching would make every assertion below vacuous.
    expect(packages().size).toBeGreaterThan(500);
  });

  it("resolves exactly one libsqlite3-sys", () => {
    const found = packages().get("libsqlite3-sys") ?? [];
    expect(found, "libsqlite3-sys missing from the lockfile entirely").toHaveLength(1);
  });

  it("resolves the libsqlite3-sys major the engine pins", () => {
    const [version] = packages().get("libsqlite3-sys") ?? [];
    expect(version, "no libsqlite3-sys in the lockfile").toBeDefined();
    expect(
      cargoMajor(version),
      `libsqlite3-sys ${version}: the engine pins ${ENGINE_LIBSQLITE3_SYS_MAJOR} and ` +
        `links = "sqlite3" admits exactly one. Reach it through rusqlite 0.39 — ` +
        `0.38 resolves 0.36 (below the >= 3.51.3 assert) and 0.40 resolves 0.38.x ` +
        `(newer, and still a collision).`,
    ).toBe(ENGINE_LIBSQLITE3_SYS_MAJOR);
  });

  it("resolves exactly one rusqlite", () => {
    // rusqlite hard-wires its libsqlite3-sys, so two rusqlite majors are two
    // libsqlite3-sys majors — the collision, one level up.
    expect(packages().get("rusqlite") ?? []).toHaveLength(1);
  });

  it("declares the same rusqlite requirement everywhere it is declared", () => {
    // Cargo would happily unify differing requirements to one version today and
    // then fail to unify once the engine pins its own. Drift is the bug.
    // Both spellings: `rusqlite = { version = "x", … }` and `rusqlite = "x"`.
    const DECL = /^\s*rusqlite\s*=\s*(?:\{[^}]*?version\s*=\s*"([^"]+)"|"([^"]+)")/gm;
    const declaredIn = new Map<string, string[]>();
    for (const manifest of ownedManifests()) {
      const found = [...read(manifest).matchAll(DECL)].map((m) => m[1] ?? m[2]);
      if (found.length) declaredIn.set(path.relative(REPO_ROOT, manifest), found);
    }

    expect(
      declaredIn.size,
      "no manifest declares rusqlite — has the regex rotted?",
    ).toBeGreaterThan(1);

    const distinct = [...new Set([...declaredIn.values()].flat())];
    expect(
      distinct,
      `rusqlite requirement drifted across ${[...declaredIn.keys()].join(", ")}`,
    ).toHaveLength(1);
  });
});

describe("the tree-sitter links collision", () => {
  const packages = () => lockPackages(ROOT_LOCK);

  it("resolves exactly one tree-sitter", () => {
    // Grammar crates (`tree-sitter-rust`, …) are separate packages with no
    // `links` key of their own; only the core crate collides.
    expect(packages().get("tree-sitter") ?? []).toHaveLength(1);
  });

  it("resolves the major both sides unify on", () => {
    const [version] = packages().get("tree-sitter") ?? [];
    expect(version, "no tree-sitter in the lockfile").toBeDefined();
    expect(
      cargoMajor(version),
      `tree-sitter ${version}: the engine is bumped to ${TREE_SITTER_MAJOR} when the ` +
        `fork lands (#42), so Atlas must stay there`,
    ).toBe(TREE_SITTER_MAJOR);
  });

  // Deliberately unconstrained: BLOCKER B also records the engine on
  // `tree-sitter-bash` 0.25.1 against Atlas's 0.23.3. Grammar crates declare no
  // `links`, so that skew is a duplicate-major compile rather than a collision
  // — a #42 cost to accept or unify, not a Phase 0 blocker.
  it("finds the grammar crates it does not constrain (parser health)", () => {
    const grammars = [...packages().keys()].filter(
      (n) => n.startsWith("tree-sitter-") && n !== "tree-sitter-language",
    );
    expect(grammars.length).toBeGreaterThan(2);
  });
});
