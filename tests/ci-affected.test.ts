import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  EXTRA_INPUTS,
  GLOBAL_INPUTS,
  NON_RUST,
  REPO_ROOT,
  affectedPackages,
  dialectPackages,
  loadWorkspace,
  matches,
  plan,
  readCrateMatrix,
  resolveRange,
} from "../scripts/ci-affected.mjs";

/**
 * Guards `scripts/ci-affected.mjs`, the planner that lets CI skip the Rust
 * jobs a change cannot affect.
 *
 * A planner that skips too much fails in the worst way: the skipped job is
 * reported "skipped", `CI passed` goes green, and the test that would have
 * failed never ran. Nothing downstream can notice. So this suite pins the
 * two ways it can under-select:
 *
 *   - A crate that reads a file outside its own directory. The planner maps
 *     files to packages by directory, so such a read is invisible unless it
 *     is declared in EXTRA_INPUTS. The scan below finds string literals in
 *     first-party Rust that resolve to an existing path outside the package
 *     (`include_str!("../../../docs/…")`, `concat!(env!("CARGO_MANIFEST_DIR"),
 *     "/../../src/…")`, `.join("../..")`) and fails on any that is not
 *     declared. A path built without a literal `..` (`.parent().join(…)`)
 *     is out of its reach; declare those by hand, as `atlas-kb-server` is.
 *   - A tracked file the planner does not classify. That fails closed (a full
 *     run), which is safe but silently throws away the saving, so every
 *     tracked file must land in a rule.
 *
 * It also pins the workflow wiring the plan depends on, since a job that
 * drops its `needs: changes`, or a `ci-ok` that stops waiting on a job,
 * type-checks, lints and runs perfectly.
 */

const workspace = loadWorkspace(REPO_ROOT);
const crates = readCrateMatrix(REPO_ROOT);
const ciYml = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const dialect = dialectPackages(ciYml);
const ctx = { workspace, crates, dialect };
const names = new Set(workspace.packages.map((p) => p.name));

function rustFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "target" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rustFiles(p, out);
    else if (e.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(REPO_ROOT, p).split(path.sep).join("/");
const inside = (dir: string, target: string) => target === dir || target.startsWith(`${dir}/`);

interface Escape {
  pkg: string;
  site: string;
  target: string;
}

/**
 * Literals in first-party Rust that point outside their package. A literal
 * is tried against both bases a path can be relative to (the source file,
 * for `include_str!`; the package directory, for `CARGO_MANIFEST_DIR` and
 * the test's working directory). It escapes only when neither lands inside
 * the package and one lands on something that exists.
 */
function escapes(): Escape[] {
  const found: Escape[] = [];
  const firstParty = workspace.packages.filter(
    (p) => p.dir === "src-tauri" || p.dir.startsWith("crates/"),
  );
  for (const pkg of firstParty) {
    const pkgAbs = path.join(REPO_ROOT, pkg.dir);
    for (const file of rustFiles(pkgAbs)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
        const lit = m[1].replace(/^\//, "");
        if (!/(^|\/)\.\.(\/|$)/.test(lit)) continue;
        const candidates = [path.dirname(file), pkgAbs].map((base) => path.resolve(base, lit));
        if (candidates.some((c) => inside(pkgAbs, c))) continue;
        const target = candidates.find((c) => inside(REPO_ROOT, c) && existsSync(c));
        if (!target) continue;
        const line = src.slice(0, m.index).split("\n").length;
        found.push({ pkg: pkg.name, site: `${rel(file)}:${line}`, target: rel(target) });
      }
    }
  }
  return found;
}

/** Whether EXTRA_INPUTS declares that `pkg` reads `target`. */
function declared({ pkg, target }: Escape): boolean {
  const mine = EXTRA_INPUTS.filter((e) => e.packages.includes(pkg));
  const isDir = target === "" || statSync(path.join(REPO_ROOT, target)).isDirectory();
  return mine.some((e) =>
    isDir
      ? // A directory read (a walk) is declared by any entry at or below it.
        target === "" || inside(target, e.path.replace(/\/$/, "")) || matches(e.path, `${target}/`)
      : matches(e.path, target),
  );
}

const run = (files: string[]) => plan(files, ctx);
const crateNames = (files: string[]) => run(files).crates.map((c) => c.crate);

describe("the CI planner sees every input", () => {
  it("finds the workspace and the out-of-tree reads it already knows about", () => {
    // Floor guards: an empty workspace or a scan that matches nothing would
    // make every assertion below pass vacuously.
    expect(workspace.packages.length).toBeGreaterThan(100);
    const sites = escapes().map((e) => e.pkg);
    expect(sites).toEqual(expect.arrayContaining(["atlas", "atlas-theme", "atlas-process"]));
  });

  it("declares every file a first-party crate reads from outside its directory", () => {
    // Add an entry to EXTRA_INPUTS in scripts/ci-affected.mjs.
    const missing = escapes().filter((e) => !declared(e));
    expect(missing).toEqual([]);
  });

  it("names only packages that exist in EXTRA_INPUTS", () => {
    const unknown = EXTRA_INPUTS.flatMap((e) => e.packages).filter((n) => !names.has(n));
    expect(unknown).toEqual([]);
  });

  it("classifies every tracked file", () => {
    // Fails closed, so this is about the saving, not safety: an unclassified
    // file makes every push that touches it run everything. Add it to
    // NON_RUST, or GLOBAL_INPUTS if it can change how Rust builds.
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(1000);
    const unclassified = tracked.filter((f) => {
      const { all } = affectedPackages([f], workspace);
      return all !== null && !GLOBAL_INPUTS.some((g) => matches(g, f));
    });
    expect(unclassified).toEqual([]);
  });

  it("keeps NON_RUST free of paths a Rust package lives under", () => {
    const shadowed = NON_RUST.filter((n) =>
      workspace.packages.some((p) => matches(n, `${p.dir}/Cargo.toml`)),
    );
    expect(shadowed).toEqual([]);
  });
});

describe("the CI plan", () => {
  it("runs no Rust job for a frontend-only change", () => {
    const p = run(["src/features/chat/components/chat-panel.tsx", "docs/adr/0001-x.md"]);
    expect({ app: p.app, dialect: p.engineDialect, crates: p.crates }).toEqual({
      app: false,
      dialect: false,
      crates: [],
    });
  });

  it("runs the app for a file it include_str!s from outside src-tauri", () => {
    const p = run(["docs/reference/configuration.md"]);
    expect(p.app).toBe(true);
    expect(p.crates).toEqual([]);
  });

  it("runs a crate's dependents, and the app, when the crate changes", () => {
    const hit = crateNames(["crates/atlas-process/src/lib.rs"]);
    expect(hit).toEqual(
      expect.arrayContaining([
        "atlas-process",
        "atlas-terminal",
        "atlas-git",
        "atlas-native-agent",
      ]),
    );
    expect(hit).not.toContain("atlas-theme");
    expect(run(["crates/atlas-process/src/lib.rs"]).app).toBe(true);
  });

  it("leaves the engine out of a change to a crate the engine does not depend on", () => {
    const p = run(["crates/atlas-redact/src/lib.rs"]);
    // Its dependents, plus atlas-process alone: the spawn audit reads every
    // crate, but only atlas-process's own tests do, so its dependents stay out.
    expect(p.crates.map((c) => c.crate).sort()).toEqual([
      "atlas-checkpoint",
      "atlas-memory",
      "atlas-process",
      "atlas-redact",
    ]);
    expect(p.engineDialect).toBe(false);
  });

  it("runs the engine dialect, the native agent and the spawn audit for an engine change", () => {
    const p = run(["vendor/atlas-engine/atlas-engine-api/src/lib.rs"]);
    expect(p.engineDialect).toBe(true);
    expect(p.app).toBe(true);
    expect(p.crates.map((c) => c.crate)).toEqual(
      expect.arrayContaining(["atlas-native-agent", "atlas-process"]),
    );
  });

  it("runs atlas-kb-server, and the app that compiles it, for a kb-server change", () => {
    const p = run(["crates/atlas-kb-server/src/main.rs"]);
    expect(p.app).toBe(true);
    expect(p.crates.map((c) => c.crate)).toContain("atlas-kb-server");
  });

  it("runs everything for a global input or an unknown file", () => {
    for (const f of ["Cargo.lock", ".github/workflows/ci.yml", "some-new-config.toml"]) {
      const p = run([f]);
      expect({ f, all: p.affected === null, n: p.crates.length }).toEqual({
        f,
        all: true,
        n: crates.length,
      });
    }
  });

  it("reads the engine dialect's packages out of ci.yml", () => {
    expect(dialect).toContain("atlas-engine-api");
    expect(dialect.filter((d) => !names.has(d))).toEqual([]);
  });
});

describe("the CI diff range", () => {
  const exists = () => true;

  it("diffs a pull request against its base", () => {
    expect(resolveRange({ GITHUB_EVENT_NAME: "pull_request", PR_BASE: "abc" }, exists)).toEqual({
      base: "abc",
      head: "HEAD",
    });
  });

  it("diffs a version-branch push against the previous head", () => {
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_NAME: "0.3.4",
      BEFORE: "a1",
      GITHUB_SHA: "b2",
    };
    expect(resolveRange(env, exists)).toEqual({ base: "a1", head: "b2" });
  });

  it("runs everything when there is no trustworthy range", () => {
    const cases = [
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main", BEFORE: "a1" },
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "0.3.5", BEFORE: "0".repeat(40) },
      { GITHUB_EVENT_NAME: "schedule" },
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { GITHUB_EVENT_NAME: "pull_request" },
    ];
    for (const env of cases) expect(resolveRange(env, exists)).toHaveProperty("all");
    const forcePushed = { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "0.3.4", BEFORE: "gone" };
    expect(resolveRange(forcePushed, () => false)).toHaveProperty("all");
  });
});

describe("the CI workflow follows the plan", () => {
  const block = (job: string) => {
    const start = ciYml.search(new RegExp(`^ {2}${job}:\\s*$`, "m"));
    if (start < 0) throw new Error(`ci.yml has no ${job} job`);
    const rest = ciYml.slice(start + 1);
    const next = rest.search(/^ {2}[a-z][a-z0-9_-]*:\s*$/m);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const jobIds = [
    ...ciYml.slice(ciYml.search(/^jobs:\s*$/m)).matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm),
  ].map((m) => m[1]);

  it("gates each planned job on the changes job's output", () => {
    expect(block("app")).toMatch(/^ {4}if: needs\.changes\.outputs\.app == 'true'$/m);
    expect(block("app-linux")).toMatch(/^ {4}if: needs\.changes\.outputs\.app == 'true'$/m);
    expect(block("engine-dialect")).toMatch(
      /^ {4}if: needs\.changes\.outputs\.engine-dialect == 'true'$/m,
    );
    expect(block("crates")).toMatch(
      /^ {8}include: \$\{\{ fromJSON\(needs\.changes\.outputs\.crates\) \}\}$/m,
    );
    expect(block("crates")).toMatch(/^ {4}if: needs\.changes\.outputs\.crates != '\[\]'$/m);
  });

  it("makes ci-ok wait on every other job, always", () => {
    const ok = block("ci-ok");
    expect(ok).toMatch(/^ {4}if: always\(\)$/m);
    const needs = ok
      .match(/^ {4}needs: \[([^\]]*)\]$/m)?.[1]
      .split(",")
      .map((s) => s.trim());
    expect(needs?.sort()).toEqual(jobIds.filter((j) => j !== "ci-ok").sort());
  });
});
