import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the root cargo workspace (issue #38, spec D4 / Phase 0).
 *
 * Atlas had no `[workspace]` until the Codex port: the old ACP stack pinned
 * `agent-client-protocol` 1.3 with an exact schema pin, the ported one pins
 * 2.0, and no single resolution could hold both. That collision is gone —
 * every consumer is on `=2.0.0` — and the port needs one workspace so the
 * vendored engine resolves against the same graph as the app.
 *
 * Three cargo rules make this checkable as text, and make silent breakage
 * likely without a check:
 *
 *   1. `[patch.crates-io]` is honored ONLY in the manifest cargo was invoked
 *      on. In a workspace that is always the root, so a patch table left
 *      behind in a member is dead config that cargo ignores without a word.
 *   2. `[profile.*]` in a non-root member is likewise ignored (cargo warns,
 *      but warnings scroll past).
 *   3. `[profile.dev.package."*"]` applies to *dependencies only*. Every
 *      Atlas crate that became a member therefore fell out of it — from
 *      opt-level 1 to 0 — unless its opt-level is restated per package. That
 *      is a pure `tauri dev` slowdown with no compile error to announce it.
 *
 * Same approach as `ci-coverage.test.ts` and `cersei-containment.test.ts`:
 * line regexes over manifests we own, with floor assertions so a regex that
 * stops matching fails loudly instead of passing vacuously.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_MANIFEST = path.join(REPO_ROOT, "Cargo.toml");

/**
 * Crates deliberately kept OUT of the workspace, with the reason.
 *
 * Keyed on DIRECTORY names (`crates/<dir>`), unlike `DEV_OPT_LEVEL_0_MEMBERS`
 * below, which is keyed on package names.
 *
 * `atlas-kb-server` is not in the app's dependency graph at all: it is a
 * template binary that `commands::knowledge_export` compiles on demand at
 * runtime, and it carries its own `[profile.release]` (`panic = "abort"`,
 * thin LTO). Profiles are workspace-global, so joining the workspace would
 * silently rebuild it under the app's fat-LTO/unwind profile. Excluded so its
 * build stays byte-for-byte what it is today.
 */
const EXCLUDED_CRATE_DIRS = new Set(["atlas-kb-server"]);

/**
 * Path dependencies that live inside the workspace directory become *implicit*
 * members unless excluded — and members fall out of `[profile.dev.package."*"]`
 * (rule 3 above), which costs `tauri dev` speed with nothing to announce it.
 *
 * Empty since #54: the two entries here were the vendored Cersei SDK patch
 * forks, and they went with the SDK. The list stays because the hazard has not
 * — the next `[patch.crates-io]` entry pointing inside this directory needs an
 * exclude, and this is where it goes.
 */
const EXCLUDED_PATCH_PATHS: string[] = [];

/** The one member allowed to have no dev opt-level override: the app crate is
 *  deliberately opt-level 0 so incremental rebuilds stay snappy. Keyed on
 *  PACKAGE names, unlike `EXCLUDED_CRATE_DIRS` above. */
const DEV_OPT_LEVEL_0_MEMBERS = new Set(["atlas"]);

/** Package names are `[a-z0-9-]`, but interpolating one into a `RegExp`
 *  unescaped is a habit that breaks the day a name isn't. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Strip whole-line comments — every manifest here cites cargo semantics in prose. */
function uncommented(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** Crate directories under `crates/` that are real cargo packages. */
function crateDirs(): string[] {
  const dir = path.join(REPO_ROOT, "crates");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "Cargo.toml")))
    .map((e) => e.name)
    .sort();
}

/** `name = "..."` from a manifest's `[package]` section — not the `name` of
 *  some later `[lib]`/`[[bin]]` table, which can legitimately differ. */
function packageName(manifest: string): string {
  const pkg = uncommented(read(manifest)).match(/^\s*\[package\]\s*$((?:(?!^\s*\[)[\s\S])*)/m);
  if (!pkg) throw new Error(`no [package] section in ${manifest}`);
  const m = pkg[1].match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error(`no package name in ${manifest}`);
  return m[1];
}

/** String entries of a root `[workspace]` array (`members` / `exclude`). */
function workspaceList(key: "members" | "exclude"): string[] {
  const src = uncommented(read(ROOT_MANIFEST));
  const block = src.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

/** Every path that should be a workspace member: all crates plus the app. */
function expectedMembers(): string[] {
  return [
    ...crateDirs()
      .filter((c) => !EXCLUDED_CRATE_DIRS.has(c))
      .map((c) => `crates/${c}`),
    "src-tauri",
  ].sort();
}

/** Manifests of the packages that are workspace members. */
function memberManifests(): string[] {
  return expectedMembers().map((rel) => path.join(REPO_ROOT, rel, "Cargo.toml"));
}

describe("root cargo workspace", () => {
  it("exists at the repository root", () => {
    expect(existsSync(ROOT_MANIFEST), "no root Cargo.toml").toBe(true);
    expect(uncommented(read(ROOT_MANIFEST))).toMatch(/^\s*\[workspace\]/m);
  });

  it("pins resolver 2", () => {
    // A workspace root defaults to resolver 1 no matter what edition its
    // members declare. Resolver 1 unifies features across build/dev/target
    // boundaries, which is not how src-tauri resolved before the workspace.
    expect(uncommented(read(ROOT_MANIFEST))).toMatch(/^\s*resolver\s*=\s*"2"/m);
  });

  it("finds the crates on disk (parser health)", () => {
    expect(crateDirs().length).toBeGreaterThan(10);
  });

  it("names every crate and src-tauri as a member", () => {
    // Subset, not equality: since #42 the members list also carries the
    // vendored Codex engine. What matters here is that none of Atlas's own
    // packages fell out of it.
    const members = workspaceList("members");
    expect(expectedMembers().filter((m) => !members.includes(m))).toEqual([]);
  });

  it("adds nothing to the members list but Atlas crates and the vendored engine", () => {
    // The complement of the assertion above: a member that is neither ours nor
    // under `vendor/codex/` is someone wiring in a third tree without saying so.
    const stray = workspaceList("members").filter(
      (m) => !expectedMembers().includes(m) && !m.startsWith("vendor/codex/"),
    );
    expect(stray).toEqual([]);
  });

  it("declares the crates it deliberately leaves out", () => {
    const excluded = workspaceList("exclude");
    for (const crate of EXCLUDED_CRATE_DIRS) {
      expect(excluded, `crates/${crate} must be excluded explicitly`).toContain(`crates/${crate}`);
    }
  });

  it("excludes the patched vendor forks so they stay dependencies", () => {
    const excluded = workspaceList("exclude");
    for (const dir of EXCLUDED_PATCH_PATHS) {
      expect(
        excluded,
        `${dir} is a [patch] path dep inside the workspace dir; without an ` +
          `exclude entry it becomes an implicit member and silently drops to ` +
          `opt-level 0`,
      ).toContain(dir);
    }
  });
});

describe("patch tables live only at the workspace root", () => {
  it("the root is where a patch table lives, and the cersei overrides are gone", () => {
    const src = uncommented(read(ROOT_MANIFEST));
    // The table itself stays: the vendored engine's own git forks are in it,
    // and a `[patch]` section is honoured only in the manifest cargo was
    // invoked on — which in a workspace is always the root.
    expect(src).toMatch(/^\s*\[patch\.crates-io\]/m);
    // The Cersei SDK overrides went with the SDK (#54). Asserted absent rather
    // than simply not asserted, because a resurrected patch entry pointing at a
    // directory that no longer exists fails resolution for the whole workspace.
    expect(src).not.toMatch(/^\s*cersei-provider\s*=/m);
    expect(src).not.toMatch(/^\s*cersei-agent\s*=/m);
  });

  it("no member manifest keeps an orphaned patch table", () => {
    // Floor guard: an empty member list would make the assertion below pass
    // while checking nothing.
    expect(memberManifests().length).toBeGreaterThan(10);
    const orphans = memberManifests()
      .filter((m) => /^\s*\[patch\./m.test(uncommented(read(m))))
      .map((m) => path.relative(REPO_ROOT, m));
    expect(orphans).toEqual([]);
  });

  it("no member manifest keeps an ignored profile section", () => {
    expect(memberManifests().length).toBeGreaterThan(10);
    const orphans = memberManifests()
      .filter((m) => /^\s*\[profile\./m.test(uncommented(read(m))))
      .map((m) => path.relative(REPO_ROOT, m));
    expect(orphans).toEqual([]);
  });
});

describe("dev-profile opt-levels survive the move into the workspace", () => {
  // Read lazily: a missing root manifest should fail these assertions, not
  // blow up collection for the whole file.
  const rootSrc = () => uncommented(read(ROOT_MANIFEST));

  it("still optimizes third-party dependencies", () => {
    // Presence is not the invariant — the level is. Same stop-at-the-next-table
    // guard as the per-member regex below.
    expect(rootSrc()).toMatch(
      /^\s*\[profile\.dev\.package\."\*"\]\s*$(?:(?!^\s*\[)[\s\S])*?opt-level\s*=\s*1/m,
    );
  });

  it("restates opt-level 1 for every member the `*` override no longer reaches", () => {
    const missing: string[] = [];
    for (const rel of expectedMembers()) {
      const name = packageName(path.join(REPO_ROOT, rel, "Cargo.toml"));
      if (DEV_OPT_LEVEL_0_MEMBERS.has(name)) continue;
      // `(?:(?!^\\s*\\[)[\\s\\S])*?` stops at the next table header. A plain
      // `[\\s\\S]*?` would run on into a *later* stanza's `opt-level = 1` and
      // pass for a member whose own stanza says 0 — or has no body at all.
      const stanza = new RegExp(
        `^\\s*\\[profile\\.dev\\.package\\.${escapeForRegExp(name)}\\]\\s*$` +
          `(?:(?!^\\s*\\[)[\\s\\S])*?opt-level\\s*=\\s*1`,
        "m",
      );
      if (!stanza.test(rootSrc())) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  // The exemption this test replaced — "the vendored engine is quarantined, on
  // no runtime path until the seam is rewired (#45); revisit in #45" — expired
  // when #45 and #54 landed: the engine now runs on every dev turn, and at the
  // profile's opt-level 0 it was ~600k LOC of streaming, rollout I/O,
  // sandboxing and apply-patch running unoptimized on the hottest path (#65).
  it("restates opt-level 1 for the vendored engine members too", () => {
    const vendored = workspaceList("members").filter((m) => m.startsWith("vendor/codex/"));
    expect(vendored.length, "member-list parser health").toBeGreaterThan(50);
    const missing: string[] = [];
    for (const rel of vendored) {
      const name = packageName(path.join(REPO_ROOT, rel, "Cargo.toml"));
      const stanza = new RegExp(
        `^\\s*\\[profile\\.dev\\.package\\.(?:"${escapeForRegExp(name)}"|${escapeForRegExp(name)})\\]\\s*$` +
          `(?:(?!^\\s*\\[)[\\s\\S])*?opt-level\\s*=\\s*1`,
        "m",
      );
      if (!stanza.test(rootSrc())) missing.push(name);
    }
    // A new vendored member gets a stanza in the block the root manifest
    // keeps for them (#65) — the `"*"` override cannot reach members.
    expect(missing).toEqual([]);
  });

  it("keeps the release profile the app shipped with", () => {
    const src = rootSrc();
    expect(src).toMatch(/^\s*\[profile\.release\]/m);
    for (const setting of [
      /codegen-units\s*=\s*1/,
      /lto\s*=\s*"fat"/,
      /strip\s*=\s*"symbols"/,
      /panic\s*=\s*"unwind"/,
      /opt-level\s*=\s*3/,
    ]) {
      expect(src).toMatch(setting);
    }
  });
});

describe("the app crate emits one crate type", () => {
  // `staticlib`/`cdylib` are the Tauri mobile template's defaults and there is
  // no mobile target here. A lib emitting a staticlib forces cargo to compile
  // every dependency with object code *and* bitcode, so LTO optimises the whole
  // graph twice and the lib unit writes a 1.7 GB archive nothing loads —
  // measured 2026-09-04, docs/research/build-performance.md (R2).
  it("the app lib is an rlib only (staticlib/cdylib double every dependency's codegen)", () => {
    expect(read(path.join(REPO_ROOT, "src-tauri", "Cargo.toml"))).toMatch(
      /^\s*crate-type\s*=\s*\["rlib"\]\s*$/m,
    );
  });
});

describe("the build scripts follow the target dir into the workspace", () => {
  /**
   * A workspace moves cargo's output from `src-tauri/target/` to the root's
   * `target/`. Nothing fails at build time when a packaging script keeps the
   * old path — the bundle is produced, the script just cannot find it, and the
   * error ("no .dmg produced") points at the wrong thing entirely. Every
   * `scripts/*.sh` is checked, not just today's DMG trio.
   */
  const shellScripts = (): string[] =>
    readdirSync(path.join(REPO_ROOT, "scripts"))
      .filter((f) => f.endsWith(".sh"))
      .map((f) => `scripts/${f}`)
      .sort();

  it("finds the scripts on disk (parser health)", () => {
    // Derived rather than listed: a hardcoded trio would keep passing the day
    // someone adds a fourth script with the old path in it.
    expect(shellScripts().length).toBeGreaterThan(2);
  });

  it("no script still looks under src-tauri/target", () => {
    const stale = shellScripts().filter((rel) =>
      uncommented(read(path.join(REPO_ROOT, rel))).includes("src-tauri/target"),
    );
    expect(stale).toEqual([]);
  });
});
