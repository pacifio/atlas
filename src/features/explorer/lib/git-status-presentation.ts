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
