/**
 * Visual treatment for the short status codes returned by `git status
 * --porcelain`. Keeping this separate from the tree lets files and collapsed
 * folders share the same semantic colors, and gives the mapping direct tests.
 */
export type GitStatusPresentation = {
  color: string;
  priority: number;
};

const PRESENTATIONS: Record<string, GitStatusPresentation> = {
  M: { color: "var(--status-warning)", priority: 3 },
  D: { color: "var(--status-error)", priority: 4 },
  U: { color: "var(--status-error)", priority: 4 },
  R: { color: "var(--status-info)", priority: 2 },
  C: { color: "var(--status-info)", priority: 2 },
  A: { color: "var(--status-success)", priority: 1 },
  "?": { color: "var(--status-info)", priority: 2 },
};

/** Returns the status color and its severity for files and collapsed folders. */
export function gitStatusPresentation(status: string): GitStatusPresentation {
  return PRESENTATIONS[status] ?? PRESENTATIONS.M;
}

/** Prefer the strongest descendant state for a collapsed folder marker. */
export function moreProminentGitStatus(
  current: GitStatusPresentation | undefined,
  next: GitStatusPresentation,
): GitStatusPresentation {
  return !current || next.priority > current.priority ? next : current;
}

/** What the tree paints: exact color per changed file, strongest descendant
 *  status per enclosing directory (for the collapsed-folder marker). */
export interface GitStatusOverlay {
  fileColors: Map<string, string>;
  dirtyDirs: Map<string, GitStatusPresentation>;
}

/**
 * Resolve a `git status` file list into the tree's paint data. Paths arrive
 * repo-relative and are joined to `root`, so they key off the same absolute
 * path the tree rows use.
 *
 * Lives here rather than inline in the `useMemo` so the ancestor walk below —
 * which is the only part of the explorer whose cost scales with the size of
 * the working tree, and which recomputes on every git-status refresh — can be
 * tested directly, including against a naive implementation.
 */
export function buildGitStatusOverlay(
  files: readonly { path: string; status: string }[],
  root: string,
): GitStatusOverlay {
  const fileColors = new Map<string, string>();
  const dirtyDirs = new Map<string, GitStatusPresentation>();

  for (const f of files) {
    const abs = `${root}/${f.path}`;
    const presentation = gitStatusPresentation(f.status);
    fileColors.set(abs, presentation.color);

    // Walk ancestors up to (and excluding) the root so each enclosing folder
    // knows it contains a change.
    let dir = abs.slice(0, abs.lastIndexOf("/"));
    while (dir.length > root.length) {
      const current = dirtyDirs.get(dir);
      // Short-circuit. Every write below continues upward carrying THIS
      // file's priority, so a directory already at or above it guarantees its
      // whole ancestor chain is too — there is nothing left to raise. Without
      // this the walk is O(files × depth) instead of O(dirty dirs), which on a
      // pathological working tree (a stray `node_modules`, a huge generated
      // diff) is tens of milliseconds per status refresh.
      if (current && current.priority >= presentation.priority) break;
      dirtyDirs.set(dir, moreProminentGitStatus(current, presentation));
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }

  return { fileColors, dirtyDirs };
}
