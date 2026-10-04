#!/usr/bin/env bun
/**
 * Runs what GitHub CI would run, on this machine, so a green run here means a
 * green run there.
 *
 *   bun run ci:local                     the jobs CI would run for this branch
 *   bun run ci:local --base origin/0.4.0 …planned against a different base
 *   bun run ci:local --all               every job
 *   bun run ci:local frontend atlas-git  just these jobs (names as CI shows them)
 *   bun run ci:local --list              the jobs, without running anything
 *   bun run ci:local --linux             CI's Linux jobs in a Linux container
 *   bun run ci:local --shell             a shell in that container
 *
 * The jobs and their commands are read out of `.github/workflows/ci.yml` at
 * run time, never copied: every `run:` step of every job, with the crate
 * matrix expanded from `.github/ci-crates.json` and its `if: matrix.<flag>`
 * conditions applied. Which jobs to run comes from the same planner CI's
 * `changes` job uses (`scripts/ci-affected.mjs`), diffing the working tree
 * against the merge base with this branch's upstream. `frontend` always runs,
 * as in CI.
 *
 * That is the difference from `bun run test:rust`, which is a quick subset:
 * it skips clippy and atlas-kb-server, and tests every crate in one cargo
 * invocation, where cargo unifies features across crates. Here each crate is
 * tested and linted from its own directory with CI's exact flags. Over 200 CI
 * runs, clippy was the largest single cause of failed jobs, and no local gate
 * ran it.
 *
 * Deliberately NOT replicated:
 *   - steps that change this machine (`git config --global`, `sudo apt-get`).
 *     CI sets a throwaway git identity; yours is used instead.
 *   - job `env:`. CI's `RUSTC_WRAPPER=sccache`, `CARGO_INCREMENTAL=0` and
 *     `CARGO_PROFILE_DEV_DEBUG` are cache tuning for throwaway runners;
 *     applying them here would rebuild your whole target/ under a second
 *     profile and lose incremental builds.
 *   - the OS, unless asked. Every job runs on this machine by default. A job
 *     CI runs on macOS (the app) is skipped on any other OS, and so is the
 *     app's Linux compile check (OS_BOUND) except on Linux; under `--linux`
 *     it runs in the container.
 *
 * `--linux` runs the jobs CI runs on Ubuntu in a container instead, built from
 * scripts/ci-linux/Dockerfile. It is the only local way to exercise Linux-only
 * code, the engine's bubblewrap sandbox above all, from a Mac or Windows.
 * Opt-in because the first run is a cold build: the container's target dir
 * cannot share the host's. It lives in a volume with the cargo registry, so
 * later runs are incremental, and every worktree of a clone shares that one
 * volume, so a new worktree starts warm. A Linux `node_modules` and `dist/`
 * are kept per checkout.
 *
 *   - Any Docker-compatible runtime: `docker` by default, ATLAS_CI_DOCKER to
 *     name another (`podman`). OrbStack, Docker Desktop and Colima all serve
 *     the `docker` CLI. On Windows, clone inside WSL2 and run from there;
 *     bind mounts from an NTFS checkout are too slow for a build.
 *   - The image is built for this machine's architecture, never emulated
 *     (emulation is 5-10x slower). CI is arm64; on an x86-64 host the result
 *     transfers except for arch-specific code, and that run is the only x86
 *     coverage the project gets, since release-linux.yml ships x86-64 builds
 *     that no CI job tests.
 *   - Inside the container, `sudo apt-get` steps are skipped (the image has
 *     what they install) and `git config --global` runs, since its HOME is a
 *     volume, not yours.
 *   - bubblewrap needs the container's seccomp, AppArmor and /proc masks
 *     relaxed (see sandboxOpts). Without them the engine's sandbox fails as
 *     it would on a runner without bwrap installed.
 *   - One container per job, as CI gives each job its own VM: started when
 *     the job starts, each step run in it with `docker exec`, removed when
 *     the job ends (or the run is interrupted). Steps of one job share its
 *     filesystem, `/tmp` and leftover processes included, exactly as they
 *     share a runner in CI; nothing outside the volumes reaches the next job.
 *   - Two lanes. The jobs left on this machine (the macOS app) run alongside
 *     the container's, which still run one after another. The two never share
 *     a target dir, so neither waits on the other's cargo lock and nothing is
 *     built twice; they only share cores, and each leaves some idle (linking,
 *     running tests). The container jobs stay sequential because they do
 *     share one target dir. This machine's lane writes to a log file, printed
 *     in full if it fails, so the terminal shows one stream.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REPO_ROOT,
  changedFiles,
  dialectPackages,
  loadWorkspace,
  plan,
  readCrateMatrix,
} from "./ci-affected.mjs";

if (typeof Bun === "undefined") {
  console.error("ci-local: run this with bun (`bun run ci:local`); it parses ci.yml with Bun.YAML");
  process.exit(2);
}

/** Jobs that plan or gate other jobs rather than check anything. */
const NOT_CHECKS = new Set(["changes", "ci-ok"]);
/** Jobs that compile for their runner's OS. Anywhere else they would repeat
 *  the macOS `app` job's check under the wrong `cfg`, so they run only there. */
const OS_BOUND = new Set(["app-linux"]);
const HOST_OS = { darwin: "macos", win32: "windows" }[process.platform] ?? process.platform;
/** A step matching this changes the machine it runs on; see the docblock. */
const MUTATES_MACHINE = /\bsudo\b|git config --global/;

const ciYmlText = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const ciYml = Bun.YAML.parse(ciYmlText);

/** `if: matrix.flag`, `if: !matrix.flag`, optionally inside `${{ }}`. */
function matrixCondition(cond, entry) {
  const c = cond
    .trim()
    .replace(/^\$\{\{/, "")
    .replace(/\}\}$/, "")
    .trim();
  const negated = c.startsWith("!");
  const m = /^matrix\.([\w-]+)$/.exec(c.replace(/^!\s*/, ""));
  if (!m) throw new Error(`ci-local: cannot evaluate step condition \`${cond}\``);
  return Boolean(entry[m[1]]) !== negated;
}

/** Every checking job in ci.yml, crate matrix expanded, as runnable steps. */
function ciJobs() {
  const jobs = [];
  for (const [id, job] of Object.entries(ciYml.jobs)) {
    if (NOT_CHECKS.has(id)) continue;
    const entries = job.strategy?.matrix?.include ? readCrateMatrix() : [null];
    for (const entry of entries) {
      const steps = [];
      for (const step of job.steps) {
        if (!step.run) continue;
        if (step.if && !(entry && matrixCondition(step.if, entry))) continue;
        const cwd = (step["working-directory"] ?? ".").replace("${{ matrix.crate }}", entry?.crate);
        if (cwd.includes("${{") || step.run.includes("${{")) {
          throw new Error(
            `ci-local: step "${step.name}" in ${id} needs an expression ci-local can't evaluate`,
          );
        }
        steps.push({ name: step.name ?? step.run.split("\n")[0], run: step.run, cwd });
      }
      const runsOn = String(job["runs-on"]);
      const os = runsOn.startsWith("ubuntu")
        ? "linux"
        : runsOn.startsWith("macos")
          ? "macos"
          : runsOn;
      jobs.push({
        id,
        name: entry ? entry.crate : (job.name ?? id),
        crate: entry?.crate,
        os,
        arch: /-arm\b/.test(runsOn) ? "arm64" : "x64",
        steps,
      });
    }
  }
  return jobs;
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/** The job names CI would run for this working tree, or null for all. */
function plannedNames(argv) {
  if (argv.includes("--all")) return { names: null, why: "--all" };
  const i = argv.indexOf("--base");
  let base = i >= 0 ? argv[i + 1] : undefined;
  if (!base) {
    try {
      base = git(["merge-base", "HEAD", "@{upstream}"]);
    } catch {
      return { names: null, why: "this branch has no upstream to diff against" };
    }
  }
  const crates = readCrateMatrix();
  const p = plan(changedFiles(base, undefined), {
    workspace: loadWorkspace(),
    crates,
    dialect: dialectPackages(ciYmlText),
  });
  const names = new Set(["frontend", ...p.crates.map((c) => c.crate)]);
  if (p.app) names.add(ciYml.jobs.app.name).add(ciYml.jobs["app-linux"].name);
  if (p.engineDialect) names.add(ciYml.jobs["engine-dialect"].name);
  return { names, why: `${p.reason} since ${base.slice(0, 12)}` };
}

/** The `[tools]` pins in mise.toml, which CI installs exactly. */
function misePins() {
  return Object.fromEntries(
    [
      ...readFileSync(path.join(REPO_ROOT, "mise.toml"), "utf8").matchAll(/^(\w+) = "([^"]+)"/gm),
    ].map((m) => [m[1], m[2]]),
  );
}

/** Warn, don't fail: a version mismatch is a reason a result may not transfer. */
function checkVersions() {
  const tools = misePins();
  const have = (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";
  const bun = have("bun");
  const node = have("node").replace(/^v/, "");
  const warn = [];
  if (tools.bun && bun !== tools.bun)
    warn.push(`bun ${bun || "missing"}, mise.toml pins ${tools.bun}`);
  if (tools.node && !(node === tools.node || node.startsWith(`${tools.node}.`))) {
    warn.push(`node ${node || "missing"}, mise.toml pins ${tools.node}`);
  }
  for (const w of warn) console.warn(`ci-local: warning: ${w} (\`mise install\` fixes it)`);
}

const DOCKER = process.env.ATLAS_CI_DOCKER || "docker";
/** Where scripts/ci-linux/Dockerfile installs entrypoint.sh. */
const ENTRYPOINT = "/usr/local/bin/ci-linux-entrypoint";
const IMAGE_DIR = path.join(REPO_ROOT, "scripts", "ci-linux");

/**
 * What bubblewrap needs from the container: seccomp off so it can create a
 * user namespace, /proc unmasked so it can mount a fresh one (Podman spells
 * that `unmask=ALL`), and AppArmor off, since Docker's default profile on
 * Ubuntu and Debian hosts denies mount. On OrbStack the first two are each
 * required; with any one missing bwrap fails before running anything.
 */
function sandboxOpts(podman) {
  return [
    "seccomp=unconfined",
    "apparmor=unconfined",
    podman ? "unmask=ALL" : "systempaths=unconfined",
  ].flatMap((o) => ["--security-opt", o]);
}

function docker(args) {
  return spawnSync(DOCKER, args, { encoding: "utf8" });
}

/** The image for the current pins, built on first use. Returns its tag. */
function ensureImage() {
  const rust = /^channel\s*=\s*"([^"]+)"/m.exec(
    readFileSync(path.join(REPO_ROOT, "rust-toolchain.toml"), "utf8"),
  )?.[1];
  const { bun, node } = misePins();
  const args = { RUST_VERSION: rust, BUN_VERSION: bun, NODE_VERSION: node };
  const hash = createHash("sha256");
  for (const f of ["Dockerfile", "entrypoint.sh"])
    hash.update(readFileSync(path.join(IMAGE_DIR, f)));
  hash.update(JSON.stringify(args));
  const tag = `atlas-ci-linux:${hash.digest("hex").slice(0, 12)}`;
  if (docker(["image", "inspect", tag]).status === 0) return tag;

  console.log(
    `ci-local: building ${tag} (Rust ${rust}, Bun ${bun}, Node ${node}); once per pin change`,
  );
  const built = spawnSync(
    DOCKER,
    [
      "build",
      "-t",
      tag,
      "--label",
      "atlas.ci-linux=1",
      ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
      IMAGE_DIR,
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error("ci-local: building the Linux image failed");
    process.exit(1);
  }
  const stale = docker([
    "image",
    "ls",
    "--filter",
    "label=atlas.ci-linux=1",
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ])
    .stdout.split("\n")
    .filter((t) => t && t !== tag);
  if (stale.length) {
    console.log(
      `ci-local: older images from previous pins remain: ${DOCKER} image rm ${stale.join(" ")}`,
    );
  }
  return tag;
}

/** Everything a `docker run` for this checkout needs; exits if no runtime. */
function containerContext() {
  const r = docker(["info", "--format", "{{json .}}"]);
  if (r.error || r.status !== 0) {
    console.error(
      `ci-local: --linux needs a running Docker-compatible runtime (\`${DOCKER}\`; ATLAS_CI_DOCKER names another).\n${(r.stderr || r.error?.message || "").trim()}`,
    );
    process.exit(2);
  }
  // `docker info` and `podman info` answer in different shapes.
  const info = JSON.parse(r.stdout);
  const podman = Boolean(info.host);
  const arch = /^(aarch64|arm64)$/.test(info.Architecture ?? info.host?.arch) ? "arm64" : "x64";
  const rootless =
    info.host?.security?.rootless === true ||
    (info.SecurityOptions ?? []).some((o) => o.includes("rootless"));
  // Rootless: root in the container is already the host user, and any other
  // uid would map to a subuid that owns nothing in the checkout.
  const uid = rootless ? 0 : (process.getuid?.() ?? 0);
  const gid = rootless ? 0 : (process.getgid?.() ?? 0);

  // Same path inside as out, so paths in errors are the ones on this machine.
  // A Windows path means nothing in a Linux container.
  const root = process.platform === "win32" ? "/repo" : REPO_ROOT;
  // A worktree's .git is a file pointing at the main checkout's git dir.
  const gitCommon = path.resolve(REPO_ROOT, git(["rev-parse", "--git-common-dir"]));
  const mounts = [`${REPO_ROOT}:${root}`];
  if (root === REPO_ROOT && !gitCommon.startsWith(REPO_ROOT + path.sep)) {
    mounts.push(`${gitCommon}:${gitCommon}`);
  }
  // Per clone, shared by all its worktrees: the target dir, cargo registry and
  // Bun cache. Keyed by the main checkout's path, so for the main checkout the
  // name is what it always was and its warm volume is kept. A new worktree
  // starts from it instead of a cold build; two runs at once take turns on
  // cargo's build lock.
  // Per checkout: a Linux node_modules (the host's holds this OS's binaries,
  // and worktrees can differ in their lockfile); and dist/, so a Linux
  // `bun run build` doesn't rewrite the host's.
  const volFor = (p) => `atlas-ci-${createHash("sha256").update(p).digest("hex").slice(0, 8)}`;
  const mainCheckout = path.basename(gitCommon) === ".git" ? path.dirname(gitCommon) : gitCommon;
  const vol = volFor(REPO_ROOT);
  mounts.push(
    `${volFor(mainCheckout)}-cache:/cache`,
    `${vol}-node-modules:${root}/node_modules`,
    `${vol}-dist:${root}/dist`,
  );

  return {
    root,
    arch,
    image: ensureImage(),
    opts: [
      ...sandboxOpts(podman),
      ...mounts.flatMap((m) => ["-v", m]),
      "-e",
      `ATLAS_UID=${uid}`,
      "-e",
      `ATLAS_GID=${gid}`,
      "-e",
      `ATLAS_OWNED=${root}/node_modules ${root}/dist`,
    ],
  };
}

/** `docker run` arguments for an interactive shell (`--shell`). */
function shellArgs(ctx) {
  return ["run", "--rm", "--init", "-it", ...ctx.opts, "-w", ctx.root, ctx.image, "bash"];
}

/** Containers started for a job and not yet removed, for cleanup on exit. */
const liveContainers = new Set();

function removeLiveContainers() {
  if (liveContainers.size) {
    spawnSync(DOCKER, ["rm", "-f", ...liveContainers], { stdio: "ignore" });
    liveContainers.clear();
  }
}
process.on("exit", removeLiveContainers);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    removeLiveContainers();
    process.exit(130);
  });
}

/**
 * Start a job's container, idle until its steps are exec'd into it. The
 * entrypoint runs once here (volume ownership); each step goes back through
 * it (see `execArgs`) for the environment and the drop to the host user.
 */
function startJobContainer(ctx) {
  const r = spawnSync(
    DOCKER,
    ["run", "-d", "--rm", "--init", ...ctx.opts, ctx.image, "sleep", "infinity"],
    { encoding: "utf8" },
  );
  const id = r.stdout?.trim();
  if (r.status !== 0 || !id) {
    console.error(`ci-local: could not start the container: ${r.stderr?.trim()}`);
    return null;
  }
  liveContainers.add(id);
  return id;
}

function stopJobContainer(id) {
  spawnSync(DOCKER, ["rm", "-f", id], { stdio: "ignore" });
  liveContainers.delete(id);
}

/**
 * `docker exec` arguments for one step. `exec` skips the image's entrypoint,
 * so the step runs through it explicitly: it sets HOME, CARGO_HOME and
 * CARGO_TARGET_DIR and drops to the host user, as it does for `docker run`.
 */
function execArgs(ctx, id, cwd, command) {
  const tty = process.stdout.isTTY && process.stdin.isTTY;
  return [
    "exec",
    ...(tty ? ["-t"] : []),
    "-w",
    path.posix.join(ctx.root, cwd),
    id,
    ENTRYPOINT,
    ...command,
  ];
}

/** Run `cmd`, resolving to its exit status (1 if it could not start). */
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Where a job runs: in the container, on this machine, or not at all. */
function placement(job, linux) {
  if (job.os === "linux" && linux) return "container";
  if ((job.os === "macos" || OS_BOUND.has(job.id)) && job.os !== HOST_OS) return "skip";
  return "native";
}

async function main(argv) {
  const linux = argv.includes("--linux");
  if (argv.includes("--shell")) {
    const ctx = containerContext();
    process.exit(spawnSync(DOCKER, shellArgs(ctx), { stdio: "inherit" }).status ?? 1);
  }

  const all = ciJobs();
  const picked = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--base");
  let jobs;
  if (picked.length) {
    const unknown = picked.filter((n) => !all.some((j) => j.name === n || j.id === n));
    if (unknown.length) {
      console.error(
        `ci-local: no such job: ${unknown.join(", ")}. Jobs: ${all.map((j) => j.name).join(", ")}`,
      );
      process.exit(2);
    }
    jobs = all.filter((j) => picked.includes(j.name) || picked.includes(j.id));
    console.log(`ci-local: ${jobs.length} job(s) by name`);
  } else {
    const { names, why } = plannedNames(argv);
    jobs = names ? all.filter((j) => names.has(j.name)) : all;
    console.log(`ci-local: ${jobs.length} of ${all.length} jobs (${why})`);
  }
  // Fastest feedback first: the frontend takes about a minute, the app longest.
  const rank = { frontend: 0, crates: 1, "engine-dialect": 2, "app-linux": 3, app: 4 };
  jobs.sort((a, b) => (rank[a.id] ?? 1) - (rank[b.id] ?? 1));

  for (const j of jobs) j.where = placement(j, linux);

  if (argv.includes("--list")) {
    for (const j of jobs) {
      const where = {
        container: "  (Linux container)",
        skip: `  (skipped: CI runs it on ${j.os})`,
        native: "",
      }[j.where];
      console.log(`\n${j.name}${where}`);
      for (const s of j.steps) {
        const skip = skipReason(j, s) ? `  (skipped: ${skipReason(j, s)})` : "";
        console.log(`  [${s.cwd}] ${s.run.replace(/\s*\n\s*/g, "; ")}${skip}`);
      }
    }
    return;
  }

  const native = jobs.some((j) => j.where === "native");
  const ctx = jobs.some((j) => j.where === "container") ? containerContext() : null;
  if (native) checkVersions();
  if (ctx) {
    const ciArch = jobs.find((j) => j.where === "container").arch;
    if (ctx.arch !== ciArch) {
      console.log(
        `ci-local: the container is ${ctx.arch} and CI's Linux jobs are ${ciArch}; results transfer except for arch-specific code.`,
      );
    }
  }
  const env = { ...process.env };
  // As in scripts/test-rust.sh: apple-sys needs the active macOS SDK.
  if (native && process.platform === "darwin" && !env.SDKROOT) {
    env.SDKROOT = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  }

  // Two lanes when both kinds of job are planned (see the docblock); one
  // otherwise, since native jobs share this machine's target dir.
  const here = jobs.filter((j) => j.where === "native");
  const lanes = ctx && here.length ? [jobs.filter((j) => j.where !== "native"), here] : [jobs];
  let log = null;
  if (lanes.length === 2) {
    log = path.join(tmpdir(), `atlas-ci-local-${process.pid}.log`);
    console.log(
      `ci-local: ${here.map((j) => j.name).join(", ")} runs on this machine alongside the container jobs; its output goes to ${log}`,
    );
  }
  const done = new Map();
  await Promise.all(
    lanes.map(async (lane, i) => {
      const out = i === 1 ? openSync(log, "w") : null;
      for (const job of lane) done.set(job, await runJob(job, ctx, env, out));
      if (out !== null) closeSync(out);
    }),
  );
  const results = jobs.map((j) => done.get(j));
  if (log && here.some((j) => done.get(j).failed)) {
    console.log(`\n── output from this machine's lane (${log}):\n`);
    console.log(readFileSync(log, "utf8"));
  }

  console.log("\nci-local summary");
  for (const r of results) {
    const status = r.skipped ? "skip" : r.failed ? "FAIL" : "ok  ";
    console.log(
      `  ${status}  ${r.job.padEnd(32)} ${String(r.secs).padStart(5)}s${r.failed ? `  (${r.failed})` : ""}`,
    );
  }
  const failures = results.filter((r) => r.failed).length;
  if (
    process.platform !== "linux" &&
    jobs.some((j) => j.where === "native" && j.os === "linux" && j.id !== "frontend")
  ) {
    console.log(
      "\n  Rust jobs ran on this OS; CI runs them on Linux, so Linux-only paths (the engine sandbox) were not exercised. `--linux` runs them in a Linux container.",
    );
  }
  process.exit(failures ? 1 : 0);
}

/**
 * Run one job's steps in order, stopping at the first failure. `out` is a file
 * descriptor to write to, or null for this terminal.
 */
async function runJob(job, ctx, env, out) {
  const say = (line) => (out === null ? console.log(line) : writeSync(out, `${line}\n`));
  if (job.where === "skip") {
    say(`\n── ${job.name}: skipped (CI runs it on ${job.os})`);
    return { job: job.name, skipped: true, secs: 0 };
  }
  const started = Date.now();
  const stdio = out === null ? "inherit" : ["ignore", out, out];
  const container = job.where === "container" ? startJobContainer(ctx) : null;
  if (job.where === "container" && !container) {
    return { job: job.name, failed: "starting the container", secs: 0 };
  }
  let failed = null;
  for (const step of job.steps) {
    const skip = skipReason(job, step);
    if (skip) {
      say(`\n── ${job.name} › ${step.name}: skipped (${skip})`);
      continue;
    }
    say(
      `\n── ${job.name} › ${step.name}${job.where === "container" ? " (container)" : ""}\n   [${step.cwd}] ${step.run.replace(/\s*\n\s*/g, " ")}`,
    );
    const command = ["bash", "-eo", "pipefail", "-c", step.run];
    const status =
      job.where === "container"
        ? await run(DOCKER, execArgs(ctx, container, step.cwd, command), { stdio })
        : await run(command[0], command.slice(1), {
            cwd: path.join(REPO_ROOT, step.cwd),
            env,
            stdio,
          });
    if (status !== 0) {
      failed = step.name;
      break;
    }
  }
  if (container) stopJobContainer(container);
  const secs = Math.round((Date.now() - started) / 1000);
  if (out !== null) {
    console.log(
      `\n── ${job.name} (this machine): ${failed ? `FAILED at ${failed}` : "ok"} in ${secs}s`,
    );
  }
  return { job: job.name, failed, secs };
}

/** Why a step doesn't run where this job runs, or null if it does. */
function skipReason(job, step) {
  if (job.where === "container") {
    return /\bsudo\b/.test(step.run) ? "the image already has what it installs" : null;
  }
  return MUTATES_MACHINE.test(step.run) ? "changes this machine" : null;
}

await main(process.argv.slice(2));
