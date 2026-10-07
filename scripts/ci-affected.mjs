#!/usr/bin/env node
/**
 * Decides which CI jobs a change needs, so a push that only touches the
 * frontend does not pay for the app's macOS build and the engine compile.
 *
 *   node scripts/ci-affected.mjs --base <rev> [--head <rev>]   plan for a range
 *   node scripts/ci-affected.mjs --base origin/0.3.4           …or vs. the work tree
 *   node scripts/ci-affected.mjs --all                         plan everything
 *   node scripts/ci-affected.mjs --github                      what CI's `changes` job runs
 *
 * Without `--head` the diff is against the working tree, untracked files
 * included, so a local run answers "what would CI run if I pushed this".
 * With `--github` the range comes from the event (see `resolveRange`) and the
 * plan is written to `$GITHUB_OUTPUT` and `$GITHUB_STEP_SUMMARY`.
 *
 * How a file becomes jobs:
 *
 *   1. GLOBAL_INPUTS (lockfile, root manifest, cargo config, this planner, …)
 *      mean everything runs.
 *   2. EXTRA_INPUTS are files a crate reads from OUTSIDE its own directory
 *      (`include_str!("../../../docs/…")`, a test walking the repo). A plain
 *      directory-to-crate mapping cannot see these, and missing one skips a
 *      test that would have failed. `tests/ci-affected.test.ts` scans the
 *      first-party crates for paths that escape their directory and fails
 *      when one is not declared here.
 *   3. A file inside a cargo package marks that package.
 *   4. A file under `vendor/` outside every package (LICENSE, NOTICE, shared
 *      fixtures) marks every vendored package.
 *   5. NON_RUST paths mark nothing.
 *   6. Anything else is unknown, and an unknown file means everything runs.
 *      The planner fails closed: a new top-level file costs one full run until
 *      it is classified, rather than silently skipping tests forever.
 *
 * Marked packages are then closed over reverse dependencies (normal, dev and
 * build), so editing `atlas-process` also runs every crate that depends on
 * it, and the app whenever any crate it links changes. The exception is an
 * EXTRA_INPUTS entry marked `testOnly`: a file only the package's own tests
 * read cannot change what its dependents compile, so it marks the package
 * alone. Without that, the spawn audit below would pull `atlas-process`'s
 * ten dependents into every change to any Rust file.
 *
 * The `frontend` job is not planned: it always runs. It takes a minute, and
 * the contract suites in `tests/` read Rust sources and manifests, so there
 * is almost no change it could safely skip.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Path patterns: a trailing `/` matches everything under that directory,
 * `*.ext` matches a top-level file with that extension, anything else is an
 * exact repo-relative path.
 */
export function matches(pattern, file) {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (pattern.startsWith("*.")) return !file.includes("/") && file.endsWith(pattern.slice(1));
  return file === pattern;
}

/** Changing any of these can change how every crate builds, or what CI runs. */
export const GLOBAL_INPUTS = [
  "Cargo.toml",
  "Cargo.lock",
  ".cargo/",
  "clippy.toml",
  "rustfmt.toml",
  ".rustfmt.toml",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".gitattributes",
  ".github/workflows/ci.yml",
  ".github/ci-crates.json",
  "scripts/ci-affected.mjs",
];

/**
 * Files a package reads from outside its own directory. `packages` are cargo
 * package names. `testOnly` means only the package's tests read it (a
 * `tests/` file or a `#[cfg(test)]` module), so its dependents are not
 * marked. Keep `why` pointing at the reading site, so a stale entry can be
 * recognised as one.
 */
export const EXTRA_INPUTS = [
  {
    path: "docs/reference/configuration.md",
    packages: ["atlas"],
    testOnly: true,
    why: "include_str! in the tests module of src-tauri/src/state/atlas_config.rs",
  },
  {
    path: "src/features/settings/lib/ui-scale.ts",
    packages: ["atlas"],
    testOnly: true,
    why: "include_str! in the tests module of src-tauri/src/state/atlas_config.rs",
  },
  {
    path: "crates/atlas-kb-server/",
    packages: ["atlas"],
    why: "commands/knowledge_export.rs locates and compiles it at runtime",
  },
  {
    path: "src/dev/mock-backend/fixtures/",
    packages: ["atlas-theme"],
    testOnly: true,
    why: "the tests module of src/lib.rs, and tests/import.rs, check the mock's snapshots",
  },
  {
    path: "docs/agents/delta-wire-contract.md",
    packages: ["atlas-agent-wire"],
    testOnly: true,
    why: "tests/contract.rs reads the prose contract when it exists",
  },
  // tests/spawn_audit.rs walks every Rust source in the workspace.
  ...["src-tauri/src/", "crates/", "vendor/atlas-engine/"].map((p) => ({
    path: p,
    packages: ["atlas-process"],
    testOnly: true,
    why: "tests/spawn_audit.rs",
  })),
];

/** Paths no Rust job reads. The frontend job, which always runs, covers them. */
export const NON_RUST = [
  "src/",
  "tests/",
  "docs/",
  "landing/",
  "public/",
  "scripts/",
  ".husky/",
  ".design-sync/",
  ".github/ISSUE_TEMPLATE/",
  ".github/pr-assets/",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/SECURITY.md",
  ".github/CODE_OF_CONDUCT.md",
  ".github/dependabot.yml",
  ".github/workflows/release-linux.yml",
  "*.md",
  "LICENSE",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "mise.toml",
  "tsconfig.json",
  "tsconfig.test.json",
  "vite.config.ts",
  "vitest.config.ts",
  "components.json",
  "index.html",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  ".gitignore",
  ".env.example",
];

/**
 * The cargo packages CI can test: every root-workspace member, plus each
 * `crates/*` package the workspace excludes (atlas-kb-server). `dir` is
 * repo-relative, `deps` the names of the packages it depends on by path.
 */
export function loadWorkspace(root = REPO_ROOT) {
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--locked"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const packages = meta.packages.map((p) => ({
    name: p.name,
    dir: rel(path.dirname(p.manifest_path)),
    deps: [...new Set(p.dependencies.filter((d) => d.path).map((d) => d.name))],
  }));
  const known = new Set(packages.map((p) => p.dir));
  for (const e of readdirSync(path.join(root, "crates"), { withFileTypes: true })) {
    const dir = `crates/${e.name}`;
    if (e.isDirectory() && !known.has(dir) && existsSync(path.join(root, dir, "Cargo.toml"))) {
      const manifest = readFileSync(path.join(root, dir, "Cargo.toml"), "utf8");
      const name = manifest.match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m)?.[1] ?? e.name;
      packages.push({ name, dir, deps: [] });
    }
  }
  return { packages };
}

/**
 * The packages `files` affect, closed over reverse dependencies, or
 * `{ all: <reason> }` when the change reaches everything.
 */
export function affectedPackages(files, workspace) {
  const byDir = workspace.packages
    .filter((p) => p.dir !== "")
    .sort((a, b) => b.dir.length - a.dir.length);
  const vendored = workspace.packages.filter((p) => p.dir.startsWith("vendor/"));
  const marked = new Set();
  const testOnly = new Set();

  for (const file of files) {
    const global = GLOBAL_INPUTS.find((g) => matches(g, file));
    if (global) return { all: `${file} changed`, packages: new Set() };

    for (const extra of EXTRA_INPUTS) {
      if (matches(extra.path, file))
        extra.packages.forEach((p) => (extra.testOnly ? testOnly : marked).add(p));
    }
    const owner = byDir.find((p) => file.startsWith(`${p.dir}/`));
    if (owner) {
      marked.add(owner.name);
    } else if (file.startsWith("vendor/")) {
      vendored.forEach((p) => marked.add(p.name));
    } else if (!NON_RUST.some((n) => matches(n, file))) {
      return { all: `${file} is not classified in scripts/ci-affected.mjs`, packages: new Set() };
    }
  }

  const dependents = new Map();
  for (const p of workspace.packages) {
    for (const d of p.deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(p.name);
    }
  }
  const queue = [...marked];
  while (queue.length) {
    for (const up of dependents.get(queue.pop()) ?? []) {
      if (!marked.has(up)) {
        marked.add(up);
        queue.push(up);
      }
    }
  }
  testOnly.forEach((p) => marked.add(p));
  return { all: null, packages: marked };
}

/** The `-p` packages the `engine-dialect` job tests, read out of ci.yml. */
export function dialectPackages(ciYml) {
  const start = ciYml.search(/^ {2}engine-dialect:\s*$/m);
  if (start < 0) throw new Error("ci.yml has no engine-dialect job");
  const rest = ciYml.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][a-z0-9_-]*:\s*$/m);
  const block = next < 0 ? rest : rest.slice(0, next);
  return [...block.matchAll(/-p ([a-z0-9_-]+)/g)].map((m) => m[1]);
}

/**
 * Which Rust jobs to run for `files`; `files === null` means run everything
 * for `allReason`.
 */
export function plan(files, { workspace, crates, dialect }, allReason = "everything requested") {
  const { all, packages } =
    files === null ? { all: allReason, packages: new Set() } : affectedPackages(files, workspace);
  const hit = (name) => all !== null || packages.has(name);
  const nameOfDir = new Map(workspace.packages.map((p) => [p.dir, p.name]));
  return {
    reason: all ?? `${files.length} changed file(s)`,
    affected: all !== null ? null : [...packages].sort(),
    app: hit(nameOfDir.get("src-tauri") ?? "atlas"),
    engineDialect: dialect.some(hit),
    crates: crates.filter((c) => hit(nameOfDir.get(`crates/${c.crate}`) ?? c.crate)),
  };
}

/** The CI crate matrix: `.github/ci-crates.json`. */
export function readCrateMatrix(root = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, ".github", "ci-crates.json"), "utf8"));
}

const NULL_SHA = /^0+$/;

/**
 * The diff range for a GitHub event, or `{ all: <reason> }` when there is no
 * trustworthy range. `commitExists` is injected so this stays testable.
 */
export function resolveRange(env, commitExists) {
  const event = env.GITHUB_EVENT_NAME;
  if (event === "schedule") return { all: "scheduled full run" };
  if (event === "workflow_dispatch") return { all: "manual run" };
  if (event === "pull_request") {
    if (!env.PR_BASE) return { all: "pull request with no base sha" };
    return { base: env.PR_BASE, head: "HEAD" };
  }
  if (event === "push") {
    // A merge to main is a release: it gets the full suite, not a diff.
    if (env.GITHUB_REF_NAME === "main") return { all: "push to main" };
    const before = env.BEFORE ?? "";
    if (!before || NULL_SHA.test(before)) return { all: "new branch, no previous head" };
    if (!commitExists(before)) return { all: "previous head is gone (force-push?)" };
    return { base: before, head: env.GITHUB_SHA || "HEAD" };
  }
  return { all: `unrecognised event ${event}` };
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/** Files changed in `base..head`, or `base..work tree` (untracked included) without `head`. */
export function changedFiles(base, head) {
  const lines = (s) => s.split("\n").filter(Boolean);
  if (head) return lines(git(["diff", "--name-only", "--no-renames", base, head]));
  return [
    ...lines(git(["diff", "--name-only", "--no-renames", base])),
    ...lines(git(["ls-files", "--others", "--exclude-standard"])),
  ];
}

const firstParty = (names) =>
  names.filter((n) => !n.startsWith("atlas-engine-")).join(", ") || "none";

function summarise(p, crates) {
  const jobs = [
    ["app (src-tauri)", p.app],
    ["app (src-tauri, Linux)", p.app],
    ["engine dialect", p.engineDialect],
    ...crates.map((c) => [c.crate, p.crates.some((x) => x.crate === c.crate)]),
  ];
  const ran = jobs.filter(([, r]) => r).length;
  return [
    `### CI plan: ${ran} of ${jobs.length} Rust jobs`,
    "",
    `Reason: ${p.reason}`,
    "",
    ...(p.affected ? [`Affected first-party packages: ${firstParty(p.affected)}`, ""] : []),
    `Running: ${
      jobs
        .filter(([, r]) => r)
        .map(([n]) => n)
        .join(", ") || "none"
    }`,
    "",
    `Skipped: ${
      jobs
        .filter(([, r]) => !r)
        .map(([n]) => n)
        .join(", ") || "none"
    }`,
    "",
  ].join("\n");
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const github = argv.includes("--github");
  let range;
  if (argv.includes("--all")) {
    range = { all: "--all" };
  } else if (github) {
    range = resolveRange(process.env, (sha) => {
      try {
        git(["cat-file", "-e", `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    });
  } else {
    range = { base: arg("--base") ?? "HEAD", head: arg("--head") };
  }

  const crates = readCrateMatrix();
  const dialect = dialectPackages(
    readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
  );
  const workspace = loadWorkspace();
  const files = range.all ? null : changedFiles(range.base, range.head);
  const result = plan(files, { workspace, crates, dialect }, range.all);

  const summary = summarise(result, crates);
  process.stdout.write(`${summary}\n`);
  if (github) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `app=${result.app}`,
        `engine-dialect=${result.engineDialect}`,
        `crates=${JSON.stringify(result.crates)}`,
        "",
      ].join("\n"),
    );
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
