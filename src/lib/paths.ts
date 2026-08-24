/** Rewrites a macOS/Linux home-directory prefix to `~/`. Any other path is returned unchanged. */
export function tildePath(p: string): string {
  const m = /^\/(?:Users|home)\/[^/]+\/(.*)$/.exec(p);
  return m ? `~/${m[1]}` : p;
}

/** Truncates a path to its last two segments, e.g. for compact breadcrumb display. */
export function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}
