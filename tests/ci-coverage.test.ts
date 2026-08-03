import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps `.github/workflows/ci.yml` bound to what is actually in the repo.
 *
 * Each crate is a standalone package, so CI names them one by one in a matrix.
 * That list is hand-maintained, which means a PR adding a crate gets a green
 * check while its tests never run — the exact failure that left 393 of this
 * repo's tests (48%) unexecuted before this suite existed. Nothing else
 * notices, because a job that was never scheduled cannot go red.
 *
 * Parsed with a line regex rather than a YAML dependency: the file is small,
 * it is ours, and the count assertions below make a silently-unmatching regex
 * fail loudly instead of passing vacuously.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRATES_DIR = path.join(REPO_ROOT, "crates");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

/** Crate directories that are real Cargo packages. */
function cratesOnDisk(): string[] {
  return readdirSync(CRATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(CRATES_DIR, e.name, "Cargo.toml")))
    .map((e) => e.name)
    .sort();
}

/** Crate names listed in the CI matrix. */
function cratesInWorkflow(): string[] {
  const src = readFileSync(WORKFLOW, "utf8");
  return [...src.matchAll(/^\s*-\s*crate:\s*([a-z0-9_-]+)\s*$/gm)].map((m) => m[1]).sort();
}

describe("CI covers the repository", () => {
  const onDisk = cratesOnDisk();
  const inWorkflow = cratesInWorkflow();

  it("finds crates on disk", () => {
    // Floor guard: if this returns nothing, the comparison below would pass
    // against an empty set and guard nothing.
    expect(onDisk.length).toBeGreaterThan(10);
  });

  it("parses crate entries out of the workflow", () => {
    expect(inWorkflow.length).toBeGreaterThan(10);
  });

  it("runs the tests of every crate in the repository", () => {
    const uncovered = onDisk.filter((c) => !inWorkflow.includes(c));
    // Add the crate to the `crates` matrix in .github/workflows/ci.yml.
    expect(uncovered).toEqual([]);
  });

  it("does not name a crate that no longer exists", () => {
    // A stale entry fails the job with a confusing "no such directory" rather
    // than pointing at the rename that caused it.
    const phantom = inWorkflow.filter((c) => !onDisk.includes(c));
    expect(phantom).toEqual([]);
  });

  it("lists each crate exactly once", () => {
    const duplicates = inWorkflow.filter((c, i) => inWorkflow.indexOf(c) !== i);
    expect([...new Set(duplicates)]).toEqual([]);
  });
});
