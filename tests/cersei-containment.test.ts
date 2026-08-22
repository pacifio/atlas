import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the cersei purge (2026-08-22): the Cersei SDK may be a dependency of
 * the native-agent stack ONLY. Everything else — most pointedly the crates
 * whose cersei internals were ported into Atlas (`atlas-memory`'s graph/
 * session/dream/embedding, `atlas-codeindex`'s tree-sitter code_intel) — must
 * never quietly regain a `cersei-*` dependency.
 *
 * Cargo can't express this ("crate X must not depend on Y" isn't a manifest
 * concept), and feature unification means one stray dep re-entangles the
 * whole tree, so the manifests are checked as text — same approach as
 * `ci-coverage.test.ts`.
 *
 * When the native agent itself is removed (the planned final step of the
 * purge), shrink ALLOWED_CERSEI_MANIFESTS in the same commit — this test
 * failing on that day is it working, not breaking.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Manifests that may declare cersei dependencies today: the in-process
 *  native agent, the agent manager that hosts it, and the app crate (which
 *  carries the vendored `cersei-provider` UTF-8 compile guard). */
const ALLOWED_CERSEI_MANIFESTS = new Set([
  "crates/atlas-cersei/Cargo.toml",
  "crates/atlas-agents/Cargo.toml",
  "src-tauri/Cargo.toml",
]);

/** A dependency-shaped cersei line: `cersei = …`, `cersei-agent = { … }`, and
 *  the `[patch.crates-io]` vendored overrides. Comment lines don't count —
 *  the ported crates legitimately cite cersei in prose. */
const CERSEI_DEP = /^\s*(cersei(-[a-z]+)?)\s*=/m;

function manifests(): string[] {
  const out: string[] = [];
  const cratesDir = path.join(REPO_ROOT, "crates");
  for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = path.join(cratesDir, entry.name, "Cargo.toml");
    if (existsSync(m)) out.push(m);
  }
  out.push(path.join(REPO_ROOT, "src-tauri", "Cargo.toml"));
  return out;
}

function declaresCersei(manifest: string): boolean {
  const src = readFileSync(manifest, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  return CERSEI_DEP.test(src);
}

describe("cersei containment", () => {
  const all = manifests();

  it("found the crate manifests (parser health)", () => {
    // 15 crates + src-tauri at the time of writing; well-under floor so a
    // crate rename never trips this, only a broken walk does.
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  it("only the native-agent stack depends on cersei", () => {
    const violations = all
      .map((m) => path.relative(REPO_ROOT, m))
      .filter((rel) => !ALLOWED_CERSEI_MANIFESTS.has(rel))
      .filter((rel) => declaresCersei(path.join(REPO_ROOT, rel)));
    expect(violations).toEqual([]);
  });

  it("the ported crates stayed ported", () => {
    // The two crates whose cersei internals were rewritten as Atlas code.
    // Listed explicitly (not just covered by the allowlist test) so a failure
    // names the regression instead of a generic violation.
    for (const rel of ["crates/atlas-memory/Cargo.toml", "crates/atlas-codeindex/Cargo.toml"]) {
      expect(declaresCersei(path.join(REPO_ROOT, rel)), `${rel} regained cersei`).toBe(false);
    }
  });
});
