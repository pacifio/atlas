import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Holds scripts/target-gc.sh to its policy. A garbage collector that stops
 * collecting fails the quietest way there is: every build stays green while
 * target/ grows back to the 67 GB it was before the script existed, and the
 * first symptom is a full disk. The opposite slip is as quiet and costs more:
 * a sweep on a downgrade (a worktree on an older version branch sharing the
 * target dir) throws away builds that the next run on the newer branch has to
 * redo from scratch.
 *
 * `rustc`, `rustup` and `cargo` are stubs on PATH: the stubs report a Rust
 * version and log every cargo invocation, so the suite checks which sweeps the
 * script asks for without needing cargo-sweep or a real target dir.
 */

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "target-gc.sh",
);

let dir: string;
let bin: string;
let target: string;
let log: string;

function stub(name: string, body: string) {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(release: string, { sweepInstalled = true } = {}) {
  stub("rustc", `echo "rustc ${release}"; echo "release: ${release}"`);
  stub("rustup", `echo "${release}-test-toolchain (overridden)"`);
  stub("cargo", `echo "$*" >> "${log}"; echo "[INFO] Cleaned 1 GiB"`);
  if (sweepInstalled) stub("cargo-sweep", "exit 0");
  else rmSync(path.join(bin, "cargo-sweep"), { force: true });
  return execFileSync("bash", [SCRIPT, target], {
    encoding: "utf8",
    // Only the stubs and the basics: a real cargo-sweep on this machine must
    // not stand in for the stub the test removed.
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });
}

const sweeps = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const stamp = () => readFileSync(path.join(target, ".atlas-gc-rustc"), "utf8").trim();
const daysAgo = (p: string, days: number) => {
  const t = Date.now() / 1000 - days * 86400;
  utimesSync(p, t, t);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "target-gc-"));
  bin = path.join(dir, "bin");
  target = path.join(dir, "target");
  log = path.join(dir, "cargo.log");
  mkdirSync(bin);
  mkdirSync(path.join(target, "debug", "incremental", "atlas_lib-abc"), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("target-gc.sh", () => {
  it("records the compiler on first sight and sweeps nothing for it", () => {
    run("1.99.0");
    expect(stamp()).toBe("1.99.0");
    expect(sweeps().filter((s) => s.includes("--toolchains"))).toEqual([]);
    expect(existsSync(path.join(target, "debug", "incremental", "atlas_lib-abc"))).toBe(true);
  });

  it("on an upgrade, sweeps what other toolchains built and drops incremental state", () => {
    run("1.99.0");
    run("1.100.0"); // sort -V, not string order: 1.100 is newer than 1.99
    expect(sweeps()).toContain("sweep --toolchains 1.100.0-test-toolchain .");
    expect(existsSync(path.join(target, "debug", "incremental"))).toBe(false);
    expect(stamp()).toBe("1.100.0");
  });

  it("never sweeps on a downgrade, and keeps the newest compiler as the mark", () => {
    run("1.99.0");
    run("1.98.0");
    expect(sweeps().filter((s) => s.includes("--toolchains"))).toEqual([]);
    expect(existsSync(path.join(target, "debug", "incremental", "atlas_lib-abc"))).toBe(true);
    expect(stamp()).toBe("1.99.0");
  });

  it("without cargo-sweep, still clears incremental state on an upgrade and says what to install", () => {
    run("1.99.0", { sweepInstalled: false });
    const out = run("1.100.0", { sweepInstalled: false });
    expect(out).toContain("cargo install cargo-sweep");
    expect(sweeps()).toEqual([]);
    expect(existsSync(path.join(target, "debug", "incremental"))).toBe(false);
  });

  it("ages out unused artifacts weekly, not on every run", () => {
    run("1.99.0");
    expect(sweeps()).toContain("sweep --time 30 .");
    run("1.99.0");
    expect(sweeps().filter((s) => s.includes("--time"))).toHaveLength(1);
    daysAgo(path.join(target, ".atlas-gc-swept"), 8);
    run("1.99.0");
    expect(sweeps().filter((s) => s.includes("--time"))).toHaveLength(2);
  });

  it("ages out incremental state no compile has touched in 30 days", () => {
    const stale = path.join(target, "debug", "incremental", "atlas_old-def");
    mkdirSync(stale);
    daysAgo(stale, 31);
    run("1.99.0");
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(path.join(target, "debug", "incremental", "atlas_lib-abc"))).toBe(true);
  });
});
