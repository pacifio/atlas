import { describe, expect, it } from "vitest";
import {
  buildGitStatusOverlay,
  gitStatusPresentation,
  moreProminentGitStatus,
  type GitStatusPresentation,
} from "./git-status-presentation";

const ROOT = "/repo";

/** The obvious implementation: no short-circuit, every file walks its whole
 *  ancestor chain. `buildGitStatusOverlay` must agree with this exactly — the
 *  break it adds is an optimization, never a behaviour change. */
function naiveOverlay(files: readonly { path: string; status: string }[], root: string) {
  const fileColors = new Map<string, string>();
  const dirtyDirs = new Map<string, GitStatusPresentation>();
  for (const f of files) {
    const abs = `${root}/${f.path}`;
    const presentation = gitStatusPresentation(f.status);
    fileColors.set(abs, presentation.color);
    let dir = abs.slice(0, abs.lastIndexOf("/"));
    while (dir.length > root.length) {
      dirtyDirs.set(dir, moreProminentGitStatus(dirtyDirs.get(dir), presentation));
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return { fileColors, dirtyDirs };
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("gitStatusPresentation", () => {
  it("uses warning for modified files and info blue for untracked files", () => {
    expect(gitStatusPresentation("M").color).toBe("var(--status-warning)");
    expect(gitStatusPresentation("?").color).toBe("var(--status-info)");
  });

  it("retains distinct semantic colors for added, deleted, renamed, and conflicted files", () => {
    expect(gitStatusPresentation("A").color).toBe("var(--status-success)");
    expect(gitStatusPresentation("D").color).toBe("var(--status-error)");
    expect(gitStatusPresentation("R").color).toBe("var(--status-info)");
    expect(gitStatusPresentation("U").color).toBe("var(--status-error)");
  });

  it("keeps the most prominent descendant status on collapsed folders", () => {
    const untracked = gitStatusPresentation("?");
    const modified = gitStatusPresentation("M");
    const conflicted = gitStatusPresentation("U");

    expect(moreProminentGitStatus(undefined, untracked)).toBe(untracked);
    expect(moreProminentGitStatus(untracked, modified)).toBe(modified);
    expect(moreProminentGitStatus(modified, conflicted)).toBe(conflicted);
  });
});

describe("buildGitStatusOverlay", () => {
  it("colors each changed file by its own status", () => {
    const { fileColors } = buildGitStatusOverlay(
      [
        { path: "src/a.ts", status: "M" },
        { path: "src/b.ts", status: "D" },
      ],
      ROOT,
    );
    expect(fileColors.get("/repo/src/a.ts")).toBe("var(--status-warning)");
    expect(fileColors.get("/repo/src/b.ts")).toBe("var(--status-error)");
  });

  it("marks every ancestor directory below the root, and never the root", () => {
    const { dirtyDirs } = buildGitStatusOverlay([{ path: "a/b/c/d.ts", status: "M" }], ROOT);
    expect([...dirtyDirs.keys()].sort()).toEqual(["/repo/a", "/repo/a/b", "/repo/a/b/c"]);
  });

  it("raises an ancestor when a later file outranks what is already recorded", () => {
    const { dirtyDirs } = buildGitStatusOverlay(
      [
        { path: "src/deep/a.ts", status: "A" }, // priority 1
        { path: "src/deep/b.ts", status: "U" }, // priority 4 — must win, all the way up
      ],
      ROOT,
    );
    expect(dirtyDirs.get("/repo/src")?.color).toBe("var(--status-error)");
    expect(dirtyDirs.get("/repo/src/deep")?.color).toBe("var(--status-error)");
  });

  it("does not lower an ancestor when a weaker file follows a stronger one", () => {
    const { dirtyDirs } = buildGitStatusOverlay(
      [
        { path: "src/deep/a.ts", status: "D" }, // priority 4
        { path: "src/deep/b.ts", status: "A" }, // priority 1 — must not overwrite
      ],
      ROOT,
    );
    expect(dirtyDirs.get("/repo/src")?.color).toBe("var(--status-error)");
  });

  it("matches the naive full-walk implementation on randomized trees", () => {
    const statuses = ["M", "D", "U", "R", "C", "A", "?"];
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const files = Array.from({ length: 120 }, () => {
        const depth = 1 + Math.floor(rand() * 5);
        const segs = Array.from({ length: depth }, () => `d${Math.floor(rand() * 4)}`);
        return {
          path: `${segs.join("/")}/f${Math.floor(rand() * 30)}.ts`,
          status: statuses[Math.floor(rand() * statuses.length)],
        };
      });

      const fast = buildGitStatusOverlay(files, ROOT);
      const slow = naiveOverlay(files, ROOT);

      expect([...fast.fileColors].sort()).toEqual([...slow.fileColors].sort());
      // Compare colors, not presentation identity — equal-priority statuses
      // (D vs U) are interchangeable and either may be recorded.
      const colors = (m: Map<string, GitStatusPresentation>) =>
        [...m].map(([k, v]) => [k, v.color]).sort();
      expect(colors(fast.dirtyDirs)).toEqual(colors(slow.dirtyDirs));
    }
  });
});
