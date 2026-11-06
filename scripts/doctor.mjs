#!/usr/bin/env node
/**
 * `bun run doctor`: checks the machine against what the repo pins and prints one
 * line per check, with a fix hint when it fails. Exits non-zero only when a
 * REQUIRED check fails; optional ones (Docker, cargo-sweep, target/ size) warn.
 *
 * Plain Node, no dependencies, every external command under a short timeout so
 * the whole run stays fast.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

/** Run a command; null when it is missing, fails or times out. */
function run(cmd, args, timeout = 2000) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout ?? ""}`.trim();
}

/** Only a failed spawn with ENOENT means the executable is not installed. */
const installed = (cmd) =>
  spawnSync(cmd, ["--version"], { timeout: 2000 }).error?.code !== "ENOENT";

let requiredFailed = false;
function report(level, label, hint) {
  const mark = level === "ok" ? "✓" : level === "warn" ? "!" : "✗";
  console.log(`${mark} ${label}`);
  if (hint && level !== "ok") console.log(`    ${hint}`);
  if (level === "fail") requiredFailed = true;
}
/** `required` decides whether a failed check is an error or just a warning. */
const check = (ok, required, label, hint) =>
  report(ok ? "ok" : required ? "fail" : "warn", label, hint);

const mise = read("mise.toml");
const wantNode = /^node\s*=\s*"(\d+)/m.exec(mise)?.[1];
const wantBun = /^bun\s*=\s*"([^"]+)"/m.exec(mise)?.[1];
const pkg = JSON.parse(read("package.json"));
const pkgBun = /^bun@(.+)$/.exec(pkg.packageManager ?? "")?.[1];
const wantRust = /^channel\s*=\s*"([^"]+)"/m.exec(read("rust-toolchain.toml"))?.[1];

// Node is this very process, so it is on PATH if we got here.
const nodeMajor = process.versions.node.split(".")[0];
// A differing version only warns (ci:local does the same): it is the pin CI
// tests with, but a newer local one usually works. A missing tool is an error.
check(
  nodeMajor === wantNode,
  false,
  `node ${process.versions.node} (mise.toml pins ${wantNode})`,
  "mise install",
);

const bun = run("bun", ["--version"]);
check(
  bun !== null && bun === wantBun && bun === pkgBun,
  bun === null,
  bun === null
    ? "bun not found"
    : `bun ${bun} (mise.toml pins ${wantBun}, packageManager ${pkgBun})`,
  "mise install  (or https://bun.sh)",
);

const rustup = run("rustup", ["show", "active-toolchain"]);
const rustupInstalled = installed("rustup");
const activeRust = rustup?.split(/\s/)[0] ?? "";
check(
  rustup !== null && activeRust.startsWith(`${wantRust}`),
  true,
  rustup === null
    ? rustupInstalled
      ? `rust toolchain ${wantRust} not installed`
      : "rustup not found"
    : `rust toolchain ${activeRust} (rust-toolchain.toml pins ${wantRust})`,
  rustupInstalled ? `rustup toolchain install ${wantRust}` : "https://rustup.rs",
);

if (process.platform === "darwin") {
  const sdk = run("xcrun", ["--show-sdk-path"]);
  check(sdk !== null, true, "Xcode command line tools", "xcode-select --install");
}

check(
  run("cargo", ["sweep", "--version"]) !== null,
  false,
  "cargo-sweep (optional: lets scripts/target-gc.sh clear stale build artifacts)",
  "cargo install cargo-sweep",
);

check(
  run("docker", ["info"], 3000) !== null,
  false,
  "docker reachable (optional: only for the Linux jobs in ci:local)",
  "start Docker Desktop or OrbStack",
);

const targetDir = join(root, "target");
if (existsSync(targetDir)) {
  const kb = Number.parseInt(run("du", ["-sk", targetDir], 2500)?.split(/\s/)[0] ?? "", 10);
  if (Number.isFinite(kb)) {
    const gb = kb / 1024 / 1024;
    check(
      gb <= 40,
      false,
      `target/ is ${gb.toFixed(1)} GB`,
      "bash scripts/target-gc.sh target  (or rm -rf target)",
    );
  } else {
    report("warn", "target/ size could not be measured (du timed out)");
  }
}

check(existsSync(join(root, "node_modules")), true, "node_modules installed", "bun install");

const hooks = run("git", ["config", "core.hooksPath"]);
check(
  hooks === ".husky/_",
  true,
  `git hooks installed (core.hooksPath = ${hooks ?? "unset"})`,
  "bun install  (the prepare script runs husky)",
);

console.log(requiredFailed ? "\nSome required checks failed." : "\nAll required checks passed.");
process.exit(requiredFailed ? 1 : 0);
