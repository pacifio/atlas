#!/usr/bin/env node
/**
 * `beforeBuildCommand` for `tauri build`: typecheck, build the frontend, and
 * then sync the result into `dist/` **by content**.
 *
 * Why not just `bun run build`: `tauri-build` prints
 * `cargo:rerun-if-changed=<frontendDist>` for the whole `dist/` directory
 * (tauri-build/src/codegen/context.rs). `vite build` empties and rewrites
 * `dist/` on every run, so every `tauri build` dirtied the app crate's build
 * script and recompiled the lib, the bin and the LTO link even when nothing
 * had changed — measured 2026-09-04 at 15m16s for a no-op build
 * (docs/research/build-performance.md, R4).
 *
 * Vite's output is content-hashed and deterministic, so only the mtimes were
 * actually changing. This script builds into `dist-next/` and copies across
 * only the files whose bytes differ, deletes the ones that disappeared, and
 * leaves everything else — mtimes included — alone. An unchanged frontend
 * therefore leaves `dist/` untouched, `rerun-if-changed` stays satisfied, and
 * a Rust-only rebuild no longer pays for a frontend it did not change.
 *
 * `bun run build` keeps doing the plain `tsc && vite build` for CI and for
 * anyone iterating on the frontend alone.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(root, "dist");
const NEXT = join(root, "dist-next");

/** Environment for child processes: repo-local binaries first. */
function childEnv() {
  const env = { ...process.env };
  env.PATH = `${join(root, "node_modules", ".bin")}${delimiter}${env.PATH ?? ""}`;
  return env;
}

/** Every file under `dir`, as paths relative to it (POSIX-ish, sorted). */
function listFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(relative(dir, child));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function sameBytes(a, b) {
  // Size first: it settles almost every changed file without reading either.
  try {
    if (statSync(a).size !== statSync(b).size) return false;
  } catch {
    return false;
  }
  const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  return digest(a) === digest(b);
}

/** Remove directories left empty after deletions, deepest first. */
function pruneEmptyDirs(dir) {
  const walk = (abs) => {
    let empty = true;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!walk(join(abs, entry.name))) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && abs !== dir) rmdirSync(abs);
    return empty;
  };
  if (existsSync(dir)) walk(dir);
}

// 1+2. Typecheck and bundle CONCURRENTLY. They used to run back to back, and
//    tsc is single-threaded while vite saturates the cores, so the sum was
//    pure waiting. `tsconfig.json` only — the test config is not part of the
//    shipped bundle and `bun run typecheck` covers it in the PR gates. tsc's
//    output is buffered and printed only on failure so vite's progress stays
//    readable; either failing fails the build, and the survivor is killed so
//    `dist-next/` is never half-written by a doomed run.
rmSync(NEXT, { recursive: true, force: true });
const spawnOpts = { cwd: root, env: childEnv(), shell: process.platform === "win32" };

console.log("[build-frontend] tsc --noEmit -p tsconfig.json  (concurrent with vite build)");
const tsc = spawn("tsc", ["--noEmit", "-p", "tsconfig.json"], {
  ...spawnOpts,
  stdio: ["ignore", "pipe", "pipe"],
});
let tscOut = "";
tsc.stdout.on("data", (d) => (tscOut += d));
tsc.stderr.on("data", (d) => (tscOut += d));

console.log("[build-frontend] vite build --outDir dist-next --emptyOutDir");
const vite = spawn("vite", ["build", "--outDir", "dist-next", "--emptyOutDir"], {
  ...spawnOpts,
  stdio: "inherit",
});

const exitOf = (child) => new Promise((res) => child.on("exit", (code) => res(code ?? 1)));
const [tscCode, viteCode] = await Promise.all([
  exitOf(tsc).then((c) => {
    if (c !== 0) vite.kill();
    return c;
  }),
  exitOf(vite).then((c) => {
    if (c !== 0) tsc.kill();
    return c;
  }),
]);
if (tscCode !== 0) {
  process.stdout.write(tscOut);
  console.error("[build-frontend] failed: tsc --noEmit -p tsconfig.json");
  process.exit(tscCode);
}
if (viteCode !== 0) {
  console.error("[build-frontend] failed: vite build");
  process.exit(viteCode);
}

// 3. Content-aware sync into `dist/`.
mkdirSync(DIST, { recursive: true });
const next = listFiles(NEXT);
if (next.length === 0) {
  console.error("[build-frontend] vite produced no files in dist-next/ — refusing to sync");
  process.exit(1);
}
const nextSet = new Set(next);

let copied = 0;
for (const rel of next) {
  const from = join(NEXT, rel);
  const to = join(DIST, rel);
  if (sameBytes(from, to)) continue;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied += 1;
}

let removed = 0;
for (const rel of listFiles(DIST)) {
  if (nextSet.has(rel)) continue;
  unlinkSync(join(DIST, rel));
  removed += 1;
}
pruneEmptyDirs(DIST);

rmSync(NEXT, { recursive: true, force: true });

const unchanged = next.length - copied;
console.log(
  `[build-frontend] dist/: ${copied} written, ${removed} deleted, ${unchanged} unchanged ` +
    `(unchanged files keep their mtime, so tauri-build's rerun-if-changed stays satisfied)`,
);
