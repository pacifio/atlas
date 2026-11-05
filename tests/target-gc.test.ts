import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

// `ci:local` runs the script on Windows too, through Git Bash. Its usr/bin holds
// bash and the coreutils the script calls; System32's bash.exe is WSL's. Outside
// Git Bash, PATH usually has only Git's cmd/, next to usr/.
const BASICS =
  process.platform === "win32"
    ? (process.env.PATH ?? "")
        .split(path.delimiter)
        .flatMap((p) => [p, path.join(p, "..", "usr", "bin")])
        .filter((p) => existsSync(path.join(p, "bash.exe")) && existsSync(path.join(p, "cat.exe")))
        .slice(0, 1)
    : ["/usr/bin", "/bin"];

let dir: string;
let bin: string;
let target: string;
let log: string;

function stub(name: string, body: string) {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(
  release: string,
  { sweepInstalled = true, env: extra = {} as Record<string, string>, target: dir_ = target } = {},
) {
  stub("rustc", `echo "rustc ${release}"; echo "release: ${release}"`);
  stub("rustup", `echo "${release}-test-toolchain (overridden)"`);
  stub("cargo", `echo "$*" >> "${log}"; echo "[INFO] Cleaned 1 GiB"`);
  if (sweepInstalled) stub("cargo-sweep", "exit 0");
  else rmSync(path.join(bin, "cargo-sweep"), { force: true });
  // Windows spells it `Path`; drop every spelling so ours is the only one.
  // The ATLAS_GC_* knobs too, so a developer's own settings can't leak in.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== "PATH" && !key.startsWith("ATLAS_GC_"),
    ),
  );
  return execFileSync("bash", [SCRIPT, dir_], {
    encoding: "utf8",
    // Only the stubs and the basics: a real cargo-sweep on this machine must
    // not stand in for the stub the test removed.
    env: { ...env, ...extra, PATH: [bin, ...BASICS].join(path.delimiter) },
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

  it("takes the ages from ATLAS_GC_UNUSED_DAYS and ATLAS_GC_EVERY_DAYS", () => {
    const env = { ATLAS_GC_UNUSED_DAYS: "3", ATLAS_GC_EVERY_DAYS: "1" };
    run("1.99.0", { env });
    expect(sweeps()).toContain("sweep --time 3 .");
    daysAgo(path.join(target, ".atlas-gc-swept"), 2);
    run("1.99.0", { env });
    expect(sweeps().filter((s) => s.includes("--time 3"))).toHaveLength(2);
  });

  it("caps the size only when ATLAS_GC_MAX_MB is set and exceeded", () => {
    writeFileSync(path.join(target, "debug", "big.rlib"), Buffer.alloc(3 * 1024 * 1024, 1));
    run("1.99.0");
    run("1.99.0", { env: { ATLAS_GC_MAX_MB: "100" } });
    expect(sweeps().filter((s) => s.includes("--maxsize"))).toEqual([]);
    expect(existsSync(path.join(target, "debug", "incremental", "atlas_lib-abc"))).toBe(true);
    // The stub sweep deletes nothing, so the dir is still over afterwards.
    const out = run("1.99.0", { env: { ATLAS_GC_MAX_MB: "1" } });
    expect(sweeps()).toContain("sweep --maxsize 1 .");
    expect(existsSync(path.join(target, "debug", "incremental"))).toBe(false);
    expect(out).toContain("still 3 MB after the sweep");
  });

  // Creating a symlink on Windows needs developer mode or admin rights.
  it.skipIf(process.platform === "win32")(
    "measures a symlinked target dir, and sweeps it only under the wrapper's lock",
    () => {
      writeFileSync(path.join(target, "debug", "big.rlib"), Buffer.alloc(3 * 1024 * 1024, 1));
      const link = path.join(dir, "linked-target");
      symlinkSync(target, link);
      const env = { ATLAS_GC_MAX_MB: "1" };
      const out = run("1.99.0", { env, target: link });
      expect(out).toContain("shared target dir");
      expect(sweeps()).toEqual([]);
      run("1.99.0", { env: { ...env, ATLAS_GC_LOCKED: "1" }, target: link });
      expect(sweeps()).toContain("sweep --maxsize 1 .");
    },
  );
});
