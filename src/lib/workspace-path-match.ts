// Which file of a known list a path written in prose means, and how to tell
// two files with the same name apart in a label. Pure; it runs in the markdown
// worker too.
//
// The list is a pull request's changed files (`file-chip-hast.ts`): paths
// relative to the checkout. Text names them loosely — the whole path, its
// tail (`lib/api.ts` for `src/lib/api.ts`), the path with the project's own
// folder in front of it, or a bare file name — and the list is in hand at
// render time, so the match is made then, never by asking the disk.

/** Whether a relative path is a bare name, to be matched by base name. */
export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return (
    trimmed !== "." &&
    trimmed !== ".." &&
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

/**
 * The one file named `basename`: an exact match first, else the only one that
 * matches ignoring case. Two exact matches are ambiguous, so neither.
 */
export function pickWorkspaceBasenameMatch(
  basename: string,
  paths: readonly string[],
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const exact = paths.filter((path) => basenameOfPath(path) === target);
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1) return null;
  const folded = target.toLowerCase();
  const foldedMatches = paths.filter((path) => basenameOfPath(path).toLowerCase() === folded);
  return foldedMatches.length === 1 ? (foldedMatches[0] ?? null) : null;
}

/**
 * A repository-relative path that repeats the end of the project's own path
 * (`acme-app/src/a.ts` written in `/Users/me/acme-app`), without the repeat;
 * null when it repeats nothing.
 */
export function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const windows = /^[A-Za-z]:[\\/]/.test(cwd);
  const fold = (segment: string | undefined) => (windows ? segment?.toLowerCase() : segment);
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/") || null;
    }
  }
  return null;
}

/**
 * The changed file a path relative to `root` names, or null: the path itself,
 * a bare name only one changed file has, the path with the project's folder
 * repeated in front, or the one changed file whose path ends with it.
 */
export function matchChangedFile(
  relativePath: string,
  changed: readonly string[],
  root: string,
): string | null {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel || rel.split("/").includes("..")) return null;
  if (changed.includes(rel)) return rel;
  if (needsWorkspaceBasenameLookup(rel)) return pickWorkspaceBasenameMatch(rel, changed);
  const stripped = stripRepeatedWorkspacePrefix(rel, root);
  if (stripped !== null && changed.includes(stripped)) return stripped;
  const tail = changed.filter((path) => path.endsWith(`/${rel}`));
  return tail.length === 1 ? (tail[0] ?? null) : null;
}

function pathParentSegments(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .slice(0, -1);
}

/**
 * For each path that shares its base name with another in `filePaths`, the
 * parent folders that tell it apart: at least two, more when two paths end in
 * the same two. A path with a unique name has no entry.
 */
export function buildFileLinkParentSuffixByPath(filePaths: readonly string[]): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const segments = normalizedPath.split("/").filter(Boolean);
    const basename = segments[segments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(normalizedPath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;
    const parents = new Map(uniquePaths.map((path) => [path, pathParentSegments(path)]));
    for (const filePath of uniquePaths) {
      const segments = parents.get(filePath) ?? [];
      if (segments.length === 0) continue;
      let depth = segments.length;
      for (let d = 1; d <= segments.length; d += 1) {
        const candidate = segments.slice(-d).join("/");
        const collides = uniquePaths.some(
          (other) =>
            other !== filePath && (parents.get(other) ?? []).slice(-d).join("/") === candidate,
        );
        if (!collides) {
          depth = d;
          break;
        }
      }
      const suffixDepth = Math.min(segments.length, Math.max(depth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }
  return suffixByPath;
}
