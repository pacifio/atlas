import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Apache-2.0 obligations for the vendored engine (issue #44, spec D11 / Phase 1).
 *
 * Atlas's own code is **MIT** (`LICENSE`, "Copyright (c) 2026 Adib Mohsin");
 * the vendored engine is **Apache-2.0**. The second cannot be absorbed into the
 * first — Apache-2.0 code stays Apache-2.0 however it is bundled — so the
 * obligations travel with the distribution rather than being satisfied by
 * Atlas's own licence file.
 *
 * Three of §4's clauses land as testable facts, and each fails silently:
 *
 *   - **§4(a)/(d)** — the licence and the NOTICE must reach *recipients*. A
 *     file sitting in the repo does not; the shipped `.app` is what a user
 *     receives, and nothing in a normal build fails when a resource is missing
 *     from it.
 *   - **§4(b)** — every modified file must carry a prominent notice that it
 *     changed. The compiler has no opinion about a missing comment, and the
 *     set of modified files only grows.
 *   - **§4(c)** — attribution inside vendored sources is never stripped. The
 *     Phase 5 rename sweep is precisely the operation that would strip it, and
 *     that sweep has not run yet, so this test exists before its risk does.
 *
 * D11 gates all rename work on these being in place, which is why this lands
 * in Phase 1 rather than alongside the renames it protects.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(REPO_ROOT, "vendor", "codex");

/** The marker every modified vendored file carries. Grep-able on purpose. */
const CHANGE_NOTICE = "Modified by Atlas";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/**
 * The commit that vendored the engine (#42) — computed, not hardcoded.
 *
 * `git log` lists newest first, so the oldest commit touching `vendor/codex`
 * is the one that created it. Everything after it is an Atlas modification,
 * which makes this the honest fork point to diff against.
 */
function vendoringCommit(): string {
  const commits = git("log", "--format=%H", "--", "vendor/codex").trim().split("\n");
  return commits[commits.length - 1];
}

/**
 * Vendored files Atlas has changed since vendoring, working tree included.
 *
 * Deliberately `git diff <commit>` rather than `<commit>..HEAD`: the working
 * tree counts, so a file edited but not yet committed is held to the rule in
 * the same session that edits it, not one commit later.
 */
function modifiedVendoredFiles(): string[] {
  return git(
    "diff",
    "--name-only",
    "--diff-filter=d", // a deleted file needs no notice
    vendoringCommit(),
    "--",
    "vendor/codex",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("§4(a) and §4(d) — the licence and NOTICE reach recipients", () => {
  it("keeps both files in the vendored tree", () => {
    expect(existsSync(path.join(VENDOR, "LICENSE"))).toBe(true);
    expect(existsSync(path.join(VENDOR, "NOTICE"))).toBe(true);
  });

  it("keeps the NOTICE text intact, Ratatui lines included", () => {
    // §4(d) would permit dropping the Ratatui lines once the TUI is gone.
    // Keeping them is the simpler and safer read, and the spec chose it.
    const notice = read(path.join(VENDOR, "NOTICE"));
    expect(notice).toMatch(/OpenAI Codex/);
    // `\s` and not a literal space: upstream's NOTICE separates "Copyright",
    // "2025" and "OpenAI" with U+00A0 non-breaking spaces. #42 requires this
    // tree stay byte-identical to upstream and §4(d) requires the notice
    // travel verbatim, so the assertion bends rather than the file.
    expect(notice).toMatch(/Copyright\s+2025\s+OpenAI/);
    expect(notice).toMatch(/Ratatui/);
    expect(notice).toMatch(/Florian Dehau/);
  });

  it("ships both in the built app bundle", () => {
    // The obligation is to recipients, and a repo file reaches none of them.
    // Tauri copies `bundle.resources` into the .app; without an entry here the
    // build succeeds and ships nothing.
    const conf = JSON.parse(read(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json")));
    const resources = conf.bundle?.resources;
    expect(resources, "bundle.resources missing").toBeDefined();

    const entries = Array.isArray(resources) ? resources : Object.keys(resources);
    const joined = entries.join("\n");
    expect(joined, "vendored LICENSE not bundled").toMatch(/vendor\/codex\/LICENSE/);
    expect(joined, "vendored NOTICE not bundled").toMatch(/vendor\/codex\/NOTICE/);
  });

  it("bundles paths that actually exist", () => {
    // A resource path that resolves to nothing is the failure this whole test
    // is about, one level up.
    const conf = JSON.parse(read(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json")));
    const resources = conf.bundle.resources;
    const sources = Array.isArray(resources) ? resources : Object.keys(resources);
    for (const src of sources) {
      if (src.includes("*")) continue; // globs are the bundler's business
      expect(
        existsSync(path.resolve(REPO_ROOT, "src-tauri", src)),
        `bundle resource does not exist: ${src}`,
      ).toBe(true);
    }
  });
});

describe("§4(b) — modified files say they were modified", () => {
  it("has the history it needs — a shallow clone cannot run this suite", () => {
    // On a depth-1 clone the oldest commit touching vendor/codex IS HEAD, so
    // the diff against it is empty and the rule below holds vacuously. Name
    // the cause here so the next person reads it instead of the symptom (#58).
    expect(
      vendoringCommit(),
      "vendoringCommit() resolved to HEAD — this is a shallow clone " +
        "(actions/checkout defaults to fetch-depth: 1). Check out with " +
        "fetch-depth: 0 so the vendoring fork point is reachable.",
    ).not.toBe(git("rev-parse", "HEAD").trim());
  });

  it("finds the modification set (parser health)", () => {
    // If this returned nothing, the rule below would hold vacuously forever.
    expect(modifiedVendoredFiles().length).toBeGreaterThan(5);
  });

  it("puts a change notice in every modified vendored file", () => {
    const missing = modifiedVendoredFiles().filter(
      (rel) => !read(path.join(REPO_ROOT, rel)).includes(CHANGE_NOTICE),
    );
    expect(
      missing,
      `these vendored files were changed without an Apache-2.0 §4(b) notice. ` +
        `Add the one-line "${CHANGE_NOTICE}" header — see CONTEXT.md, ` +
        `"Vendored engine licensing".`,
    ).toEqual([]);
  });
});

describe("§4(c) and the rename sweep — the rules are written down", () => {
  it("records them in CONTEXT.md, where rename work looks", () => {
    // Deliberately CONTEXT.md and not a doc of its own: CLAUDE.md makes it the
    // single-context file, so it is what the Phase 5 rename tickets will read.
    const context = read(path.join(REPO_ROOT, "CONTEXT.md"));
    expect(context).toMatch(/Vendored engine licensing/);
    expect(context, "attribution-retention rule (§4(c)) not recorded").toMatch(
      /never strip|attribution/i,
    );
    expect(context, "change-notice convention (§4(b)) not recorded").toMatch(
      new RegExp(CHANGE_NOTICE),
    );
    expect(context, "trademark rule (§6) not signposted for the rename").toMatch(/trademark|§6/i);
  });
});
