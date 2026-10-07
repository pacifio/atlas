import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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
/** Where the engine lives now (ADR-0011) … */
const VENDOR = path.join(REPO_ROOT, "vendor", "atlas-engine");
/** … and the path it was vendored under, which is where its git history is. */
const VENDORED_AT = "vendor/codex";
/**
 * The commit that vendored the engine (#42). Also computed below from the
 * history of `VENDORED_AT`; the two must agree, so a rewritten history is
 * noticed rather than silently moving the fork point.
 */
const VENDORING_COMMIT = "67fb707d3d5fd35f57726fcb17ed3177bcc34c58";
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const BUNDLED_CODEX_LICENSE = "licenses/OpenAI-Codex-LICENSE.txt";
const BUNDLED_CODEX_NOTICE = "licenses/OpenAI-Codex-NOTICE.txt";

/** The marker every modified vendored file carries. Grep-able on purpose. */
const CHANGE_NOTICE = "Modified by Atlas";

/**
 * The second body of vendored third-party code: Material Icon Theme, bundled
 * as Atlas's default icon theme (theme-system decision 12).
 *
 * MIT rather than Apache-2.0, so the obligation is shorter — the copyright
 * notice and the licence text travel with every copy — but it fails the same
 * silent way. A repo file reaches no recipient, and nothing in a build goes red
 * when the `.app` ships the icons without the licence that permits them.
 *
 * The rest of this file guards a *fork point*; these guard a *snapshot*. The
 * shared rule is that the licence never gets separated from what it covers.
 */
const MATERIAL_VENDOR = path.join(
  REPO_ROOT,
  "crates",
  "atlas-icon-theme",
  "vendor",
  "material-icon-theme",
);
const BUNDLED_MATERIAL_LICENSE = "licenses/Material-Icon-Theme-LICENSE.txt";

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
  // `--full-history` disables TREESAME simplification: with merges in the
  // history, plain `git log -- <path>` follows a single parent and can miss
  // the commits that actually touched it. The pathspec is the ORIGINAL
  // location: the tree moved to `vendor/atlas-engine` in ADR-0011, and the
  // oldest commit touching the old path is still the one that created it.
  const log = git("log", "--full-history", "--format=%H", "--", VENDORED_AT).trim();
  // Empty means no commit in this checkout touched `vendor/codex` at all —
  // only possible on a shallow clone, since the vendoring commit is always in
  // full history. Returning "" here would make every later `git diff` compare
  // against nothing and report an empty modification set, which is how a
  // missing `fetch-depth: 0` surfaced as "expected 0 to be greater than 5"
  // rather than as the clone problem it is (#58).
  if (log === "") return SHALLOW;
  const commits = log.split("\n");
  return commits[commits.length - 1];
}

/** Sentinel for "this checkout has no vendor history", so the guard below can
 *  name the cause instead of every other test failing vacuously. */
const SHALLOW = "<shallow-clone>";

/**
 * Vendored files Atlas has changed since vendoring, working tree included.
 *
 * Compared by blob hash against the fork commit's tree at the same relative
 * path, rather than by `git diff`: the tree was moved (ADR-0011), so a path
 * diff would call every file new, and the working tree must count so a file
 * edited but not yet committed is held to the rule in the same session that
 * edits it. A file with no counterpart in the fork tree was renamed, and a
 * rename changed its contents too, so it is modified.
 */
/** Hashing the ~4k vendored files is the slow part; two tests need the
 *  answer and the tree cannot change mid-run, so it is computed once, in the
 *  describe's `beforeAll` with a budget of its own (a concurrent build pushed
 *  a per-test 5s past its limit on a pre-commit run). */
let modifiedCache: string[] | null = null;
function modifiedVendoredFiles(): string[] {
  modifiedCache ??= computeModifiedVendoredFiles();
  return modifiedCache;
}

function computeModifiedVendoredFiles(): string[] {
  const forkBlobs = new Map<string, string>();
  for (const line of git("ls-tree", "-r", `${vendoringCommit()}:${VENDORED_AT}`).split("\n")) {
    if (!line) continue;
    const [meta, rel] = line.split("\t");
    forkBlobs.set(rel, meta.split(" ")[2]);
  }
  const files = walk(VENDOR);
  // Repo-relative with `/`: git matches `.gitattributes` against the path it
  // is given, and a Windows absolute path (`C:\...`) matches no pattern — so
  // the CRLF fixtures' nested `-text` rule was skipped, their bytes were
  // normalised to LF before hashing, and they read as "modified".
  const relative = files.map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
  const hashes = execFileSync("git", ["hash-object", "--stdin-paths"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: relative.join("\n") + "\n",
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  return files
    .filter(
      (rel, i) => forkBlobs.get(path.relative(VENDOR, rel).split(path.sep).join("/")) !== hashes[i],
    )
    .map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
}

/** Every file under `dir`, `target/` excluded, as repo-relative paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "target") out.push(...walk(p));
    } else out.push(p);
  }
  return out.sort();
}

/**
 * Extensions whose files can carry a comment, and therefore must carry the
 * notice. Anything else that is modified must be listed in
 * `vendor/atlas-engine/ATLAS-CHANGES.md` instead — the tree-level notice for
 * files that have no comment syntax (insta snapshots, compressed schema blobs,
 * images, fixtures read verbatim).
 */
const COMMENTABLE = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".proto",
  ".lark",
  ".md",
  ".html",
  ".svg",
  ".xml",
  ".manifest",
  ".toml",
  ".py",
  ".sh",
  ".yaml",
  ".yml",
  ".ps1",
  ".rules",
  ".sbpl",
  ".sql",
  ".json",
]);

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
    expect(entries, "vendored LICENSE not bundled").toContain(BUNDLED_CODEX_LICENSE);
    expect(entries, "vendored NOTICE not bundled").toContain(BUNDLED_CODEX_NOTICE);
  });

  it("bundles byte-identical copies of the vendored LICENSE and NOTICE", () => {
    // Windows WiX cannot bundle two source files named LICENSE. The bundle
    // therefore ships explicitly named copies; keep the legal texts tied to
    // the canonical vendored files rather than merely checking their paths.
    expect(read(path.join(TAURI_DIR, BUNDLED_CODEX_LICENSE))).toBe(
      read(path.join(VENDOR, "LICENSE")),
    );
    expect(read(path.join(TAURI_DIR, BUNDLED_CODEX_NOTICE))).toBe(
      read(path.join(VENDOR, "NOTICE")),
    );
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
        existsSync(path.resolve(TAURI_DIR, src)),
        `bundle resource does not exist: ${src}`,
      ).toBe(true);
    }
  });
});

describe("§4(b) — modified files say they were modified", () => {
  beforeAll(() => {
    modifiedVendoredFiles();
  }, 120_000);

  it("has the history it needs — a shallow clone cannot run this suite", () => {
    // On a depth-1 clone the oldest commit touching the vendored path IS HEAD, so
    // the diff against it is empty and the rule below holds vacuously. Name
    // the cause here so the next person reads it instead of the symptom (#58).
    const resolved = vendoringCommit();
    const shallowHelp =
      "this is a shallow clone (actions/checkout defaults to fetch-depth: 1). " +
      "Check out with fetch-depth: 0 so the vendoring fork point is reachable.";
    // Two shapes of the same problem: no vendor history at all, or a history
    // so short that the fork point collapses onto HEAD.
    expect(resolved, `no commit here touches ${VENDORED_AT} — ${shallowHelp}`).not.toBe(SHALLOW);
    expect(resolved, `vendoringCommit() resolved to HEAD — ${shallowHelp}`).not.toBe(
      git("rev-parse", "HEAD").trim(),
    );
    expect(resolved, "the fork point moved — was history rewritten?").toBe(VENDORING_COMMIT);
  });

  it("finds the modification set (parser health)", () => {
    // If this returned nothing, the rule below would hold vacuously forever.
    expect(modifiedVendoredFiles().length).toBeGreaterThan(5);
  });

  // Reads every modified vendored file. The hashing is in `beforeAll`; the
  // reading is not. Under 1s on a quiet machine, but past vitest's 5s default
  // when the disk is busy (a cargo build, a parallel suite, the pre-commit
  // hook): 12-14s observed on Windows, failing a run that had found nothing
  // wrong (#334). The budget is for a slow disk, not a slow check.
  it("puts a change notice in every modified vendored file", () => {
    const modified = modifiedVendoredFiles().filter(
      (rel) => rel !== "vendor/atlas-engine/LICENSE" && rel !== "vendor/atlas-engine/NOTICE",
    );
    // Generated fixtures (the schema exports a test regenerates and compares
    // byte-for-byte) cannot carry a header either: the generator would drop
    // it, or the comparison would fail. They are listed in ATLAS-CHANGES.md
    // under their directory, which is the tree-level notice for them.
    const changes = read(path.join(VENDOR, "ATLAS-CHANGES.md"));
    const listed = (rel: string) => {
      const inside = rel.slice("vendor/atlas-engine/".length);
      const dirs = changes
        .split("\n")
        .map((l) => l.trim().replace(/^[-*]\s*`?|`$/g, ""))
        .filter((l) => l.endsWith("/"));
      return changes.includes(inside) || dirs.some((d) => inside.startsWith(d));
    };
    const missing = modified.filter(
      (rel) =>
        COMMENTABLE.has(path.extname(rel)) &&
        !listed(rel) &&
        !read(path.join(REPO_ROOT, rel)).includes(CHANGE_NOTICE),
    );
    expect(
      missing,
      `these vendored files were changed without an Apache-2.0 §4(b) notice. ` +
        `Add the one-line "${CHANGE_NOTICE}" header — see CONTEXT.md, ` +
        `"Vendored engine licensing":\n${missing.slice(0, 80).join("\n")}`,
    ).toEqual([]);

    // Files with no comment syntax carry their notice at tree level instead.
    const unlisted = modified.filter((rel) => !COMMENTABLE.has(path.extname(rel)) && !listed(rel));
    expect(
      unlisted,
      `modified files that cannot carry a comment must be listed in ATLAS-CHANGES.md:\n${unlisted.join("\n")}`,
    ).toEqual([]);
  }, 60_000);
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

describe("the bundled Material Icon Theme keeps its MIT notice", () => {
  it("keeps the licence beside the icons it covers", () => {
    const license = read(path.join(MATERIAL_VENDOR, "LICENSE.txt"));
    expect(license).toMatch(/MIT License/i);
    expect(license, "the copyright line is the part MIT actually requires").toMatch(
      /Copyright \(c\) \d{4} Material Extensions/,
    );
  });

  it("records where the assets came from", () => {
    // Upstream, registry, version and date. Without it the next person to
    // update the icons cannot tell what they are updating *from*.
    const attribution = read(path.join(MATERIAL_VENDOR, "ATTRIBUTION.txt"));
    expect(attribution).toMatch(/material-extensions\/vscode-material-icon-theme/);
    expect(attribution).toMatch(/open-vsx\.org/);
    expect(attribution).toMatch(/\d+\.\d+\.\d+/);
    expect(attribution, "the CC BY-SA exclusion is a decision, not a preference").toMatch(
      /vscode-icons/,
    );
  });

  it("ships the licence in the built app bundle", () => {
    const conf = JSON.parse(read(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json")));
    const resources = conf.bundle?.resources;
    const entries = Array.isArray(resources) ? resources : Object.keys(resources);
    expect(entries, "Material Icon Theme licence not bundled").toContain(BUNDLED_MATERIAL_LICENSE);
  });

  it("bundles a byte-identical copy", () => {
    expect(read(path.join(TAURI_DIR, BUNDLED_MATERIAL_LICENSE))).toBe(
      read(path.join(MATERIAL_VENDOR, "LICENSE.txt")),
    );
  });

  it("still has the icons the licence covers", () => {
    // A licence with nothing under it, or icons with no licence, are the same
    // failure seen from either end.
    const icons = readdirSync(path.join(MATERIAL_VENDOR, "icons")).filter((f) =>
      f.endsWith(".svg"),
    );
    expect(icons.length).toBeGreaterThan(1000);
    expect(existsSync(path.join(MATERIAL_VENDOR, "dist", "material-icons.json"))).toBe(true);
  });

  it("does not vendor vscode-icons, whose icons are CC BY-SA", () => {
    // Decision 12 names it explicitly. CC BY-SA would put a share-alike
    // obligation on anything Atlas ships alongside it, which MIT does not.
    const vendored = readdirSync(path.join(REPO_ROOT, "crates", "atlas-icon-theme", "vendor"));
    expect(vendored).not.toContain("vscode-icons");
  });
});
