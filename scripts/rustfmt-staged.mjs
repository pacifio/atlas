#!/usr/bin/env node
/**
 * lint-staged's Rust formatter: `rustfmt` on the staged `.rs` files, each
 * with the edition of the crate that owns it.
 *
 * Why not `cargo fmt`: it formats whole packages, so one staged file would
 * rewrite every unstaged file around it. Why not a bare `rustfmt`: without
 * `--edition` it formats as 2015, and the workspace mixes editions — the
 * first-party crates are 2021 while the root sets 2024 for the
 * engine — so the edition comes from the nearest `Cargo.toml`, exactly as
 * `cargo fmt` would pick it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT_EDITION = editionOf(path.resolve("Cargo.toml")) ?? "2021";

/** `edition = "…"` in a manifest; `edition.workspace = true` defers to the root. */
function editionOf(manifest) {
  const text = readFileSync(manifest, "utf8");
  if (/^\s*edition\.workspace\s*=\s*true/m.test(text)) return ROOT_EDITION;
  return /^\s*edition\s*=\s*"(\d{4})"/m.exec(text)?.[1] ?? null;
}

function crateEdition(file) {
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "Cargo.toml");
    if (existsSync(manifest)) return editionOf(manifest) ?? "2015";
    if (dir === path.dirname(dir)) return ROOT_EDITION;
  }
}

const byEdition = new Map();
for (const file of process.argv.slice(2)) {
  const edition = crateEdition(file);
  byEdition.set(edition, [...(byEdition.get(edition) ?? []), file]);
}

let status = 0;
for (const [edition, files] of byEdition) {
  const run = spawnSync("rustfmt", ["--edition", edition, ...files], { stdio: "inherit" });
  if (run.error) {
    console.error(`rustfmt-staged: could not run rustfmt (${run.error.message})`);
    process.exit(1);
  }
  status ||= run.status ?? 1;
}
process.exit(status);
