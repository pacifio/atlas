import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps the vendored Codex engine quarantined (issue #42, spec D2 / Phase 1).
 *
 * The engine landed whole and compiles as workspace members, but **nothing
 * that ships may depend on it** until the seam is rewired (#45) and the
 * phone-home paths are ripped out (#43). Those two are the reason the
 * quarantine is not merely tidiness: `codex-analytics` and `codex-otel` are in
 * the closure, and both phone home — one to a Statsig endpoint with a
 * hardcoded client key, one to the ChatGPT backend, the second of which sends
 * events *even under plain API-key auth* (fork-seam §3). D2 is explicit that
 * these are removed "before any build leaves developers' machines". A stray
 * `codex-*` dependency added to `src-tauri` before #43 lands would ship them.
 *
 * Cargo cannot enforce this. An unused workspace member is not an error, and
 * adding a dependency on one is the most ordinary edit there is — it compiles,
 * it passes clippy, and the only symptom is in the shipped binary.
 *
 * This is the same shape as `cersei-containment.test.ts`: an allowlist of
 * manifests permitted to name the dependency, enforced over every manifest
 * Atlas owns.
 *
 * **#45 opened the first hole in it, on purpose.** The seam crate now links the
 * engine — that is what "rewire the seam" means — so `crates/atlas-native-agent`
 * is allowlisted below. What is *not* relaxed is the rule that matters: the
 * engine reaches no shipping binary. It is behind the `ported-engine` cargo
 * feature, which is off by default, so a default build of the app resolves
 * exactly as it did before the port. The last assertion here is what holds that
 * line, and it is now the load-bearing one.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(REPO_ROOT, "vendor", "codex");

/**
 * Manifests allowed to declare a `codex-*` dependency.
 *
 * Exactly one, and it earns it: the seam is where ADR-0004 puts the engine.
 * Every dependency it declares is `optional = true` behind `ported-engine`,
 * which `default = []` leaves off — enforced below, because "optional" in a
 * manifest is a claim and this test is what checks it.
 */
const ALLOWED_CODEX_CONSUMERS = new Set<string>(["crates/atlas-native-agent/Cargo.toml"]);

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Strip whole-line comments so prose naming a crate is not read as a dep. */
function uncommented(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** Every manifest Atlas owns, excluding the vendored engine's own tree. */
function atlasManifests(): string[] {
  const out: string[] = [path.join(REPO_ROOT, "src-tauri", "Cargo.toml")];
  const crates = path.join(REPO_ROOT, "crates");
  for (const e of readdirSync(crates, { withFileTypes: true })) {
    const m = path.join(crates, e.name, "Cargo.toml");
    if (e.isDirectory() && existsSync(m)) out.push(m);
  }
  return out;
}

/** Vendored crate directories (recursive — some live under `ext/` and `utils/`). */
function vendoredManifests(dir = VENDOR): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...vendoredManifests(p));
    else if (e.name === "Cargo.toml") out.push(p);
  }
  return out;
}

/** `codex-foo = …` / `codex-foo.workspace = true` in a dependency table. */
const CODEX_DEP = /^\s*(codex-[a-z0-9-]+|app_test_support|core_test_support)\s*[.=]/m;

describe("the vendored engine is present and whole", () => {
  it("is vendored under vendor/codex", () => {
    expect(existsSync(VENDOR), "vendor/codex is missing").toBe(true);
  });

  it("carries upstream's LICENSE and NOTICE", () => {
    // Apache-2.0 §4 travels with the code, not just with the commit message.
    for (const f of ["LICENSE", "NOTICE"]) {
      expect(existsSync(path.join(VENDOR, f)), `vendor/codex/${f} missing`).toBe(true);
    }
    expect(read(path.join(VENDOR, "NOTICE"))).toMatch(/OpenAI/);
    expect(read(path.join(VENDOR, "LICENSE"))).toMatch(/Apache License/);
  });

  it("vendors the whole closure, not a sample", () => {
    // 105 crates for the D1 app-server-client surface, plus the 5 test-support
    // crates their dev-dependencies need. A number this specific is a tripwire:
    // if it moves, someone changed the closure and should say why.
    expect(vendoredManifests()).toHaveLength(110);
  });

  it("is committed whole — no file inside it is gitignored", () => {
    // The repo ignores `*.md` broadly. That rule silently swallowed 35 paths of
    // the engine on first vendoring, among them `core/*_prompt.md` — the baked
    // system prompts, `include_str!`d at compile time. The tree still built
    // from the working copy and would have failed from a fresh clone, which is
    // why this asks git rather than trusting the .gitignore negation to stay.
    const ignored = execFileSync("git", ["status", "--porcelain", "--ignored", "vendor/codex"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((l) => l.startsWith("!! "))
      .map((l) => l.slice(3));
    expect(ignored).toEqual([]);
  });

  it("is a plain copy — no submodule, no upstream remote", () => {
    for (const stray of [".git", ".gitmodules"]) {
      expect(existsSync(path.join(VENDOR, stray)), `vendor/codex/${stray} exists`).toBe(false);
    }
    expect(existsSync(path.join(REPO_ROOT, ".gitmodules"))).toBe(false);
  });
});

describe("nothing that ships depends on the vendored engine", () => {
  it("finds Atlas's manifests (parser health)", () => {
    expect(atlasManifests().length).toBeGreaterThan(10);
  });

  it("no Atlas crate declares a codex dependency", () => {
    const offenders = atlasManifests()
      .filter((m) => CODEX_DEP.test(uncommented(read(m))))
      .map((m) => path.relative(REPO_ROOT, m))
      .filter((rel) => !ALLOWED_CODEX_CONSUMERS.has(rel));
    expect(
      offenders,
      "the engine still phones home (codex-analytics, codex-otel) until #43 " +
        "rips those paths out — nothing shippable may depend on it before then",
    ).toEqual([]);
  });

  it("the engine is reachable from no shipping binary", () => {
    // src-tauri is the only thing that becomes the app. Checked separately from
    // the sweep above so a failure names the app rather than "some manifest".
    //
    // Still absolute after #45: src-tauri depends on the *seam*, and the seam's
    // engine dependencies are off unless someone asks for them. A direct
    // `codex-*` line here would put the engine in the shipped binary no matter
    // what the feature says.
    const app = uncommented(read(path.join(REPO_ROOT, "src-tauri", "Cargo.toml")));
    expect(CODEX_DEP.test(app)).toBe(false);
  });

  it("every allowlisted codex dependency is optional, behind an off-by-default feature", () => {
    // The allowlist grants the seam the right to *name* the engine, not to
    // link it into a default build. Without this, dropping `optional = true`
    // from one line would ship 105 crates of engine and nothing would notice:
    // it compiles, it passes clippy, and the only symptom is in the binary.
    const manifest = read(path.join(REPO_ROOT, "crates", "atlas-native-agent", "Cargo.toml"));
    const declarations = uncommented(manifest)
      .split("\n")
      .filter((l) => /^\s*codex-[a-z0-9-]+\s*=/.test(l));

    expect(declarations.length, "the seam should declare the engine crates").toBeGreaterThan(5);
    const notOptional = declarations.filter((l) => !/optional\s*=\s*true/.test(l));
    expect(notOptional, "a codex dependency the seam links unconditionally").toEqual([]);

    // And the feature that turns them on is not in `default`.
    const defaultFeature = /^\s*default\s*=\s*\[(.*?)\]/m.exec(manifest);
    expect(defaultFeature, "atlas-native-agent must declare a default feature list").not.toBeNull();
    expect(defaultFeature?.[1].trim(), "the ported engine must not be a default feature").toBe("");
  });
});
