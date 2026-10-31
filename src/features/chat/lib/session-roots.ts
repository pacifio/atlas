// The folders a session works in — its own project first, then the projects
// attached to it — and the one rule every changes surface groups by: a file
// belongs to the deepest root that holds it, and a file no root holds goes to
// "Other".
//
// The changed-files card, the diff panel and the overlay's Changes row all
// read this, so a file lands in the same group, under the same name, with the
// same root-relative path, wherever it is shown. Pure: callers memoize on the
// root list and the file list, both of which keep their identity while
// nothing changes.

import { tildePath } from "@/lib/paths";
import type { AttachedProject, ProjectAccess } from "./history-api";
import { isAbsolutePath, joinPath, toRepoRelative } from "./open-turn-diff";

export interface SessionRoot {
  /** Absolute. The identity. */
  path: string;
  name: string;
  /** `main`: the session's own project, where it runs. */
  kind: "main" | "attached";
  /** An attached project's access; absent on the main project. */
  access?: ProjectAccess;
}

/** Between a project's name and a path inside it, where one list holds files
 *  from several roots (the diff panel's keys): `docs › guide/setup.mdx`. */
export const ROOT_SEPARATOR = " › ";

/** The group key of files no root holds. */
export const OTHER_GROUP = "\0other";

export interface RootGroup<T> {
  /** The root's path, or {@link OTHER_GROUP}. */
  key: string;
  /** `null` for "Other". */
  root: SessionRoot | null;
  /** The project's name, or "Other". */
  label: string;
  items: T[];
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]|^\\\\/;

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** `path` is `root` or inside it. Separators and, on Windows, case don't count. */
export function isUnderRoot(path: string, root: string): boolean {
  if (!root) return false;
  const windows = WINDOWS_ABSOLUTE.test(root) || WINDOWS_ABSOLUTE.test(path);
  let p = trimSlash(path);
  let r = trimSlash(root);
  if (windows) {
    p = p.replace(/\\/g, "/").toLowerCase();
    r = r.replace(/\\/g, "/").toLowerCase();
  }
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * The session's roots: the main project, then each attached project in the
 * order it was attached. An attached path that is the main project is left
 * out — it is already there.
 */
export function sessionRoots(
  main: { path: string; name: string } | null,
  attached: readonly AttachedProject[] | undefined,
): SessionRoot[] {
  const roots: SessionRoot[] = [];
  if (main?.path) roots.push({ path: trimSlash(main.path), name: main.name, kind: "main" });
  for (const p of attached ?? []) {
    if (roots.some((r) => isUnderRoot(p.path, r.path) && isUnderRoot(r.path, p.path))) continue;
    roots.push({
      path: trimSlash(p.path),
      name: p.displayName,
      kind: "attached",
      access: p.access,
    });
  }
  return roots;
}

/** The deepest root holding the absolute `path`, so a project nested in
 *  another claims its own files. `null` when none does. */
export function rootOf(path: string, roots: readonly SessionRoot[]): SessionRoot | null {
  let best: SessionRoot | null = null;
  for (const root of roots) {
    if (!isUnderRoot(path, root.path)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

/**
 * Where a file a turn or the record names belongs. `path` is absolute, or
 * relative to the main root (git's and the record's spelling). The answer
 * carries the path relative to its own root, or, for "Other", the absolute
 * path with the home folder as `~`.
 */
export function placeFile(
  path: string,
  roots: readonly SessionRoot[],
): { root: SessionRoot | null; rel: string; abs: string } {
  const main = roots.find((r) => r.kind === "main") ?? null;
  const abs = isAbsolutePath(path) || !main ? path : joinPath(main.path, path);
  const root = isAbsolutePath(abs) ? rootOf(abs, roots) : main;
  if (!root) return { root: null, rel: tildePath(abs), abs };
  const rel = toRepoRelative(abs, root.path);
  return { root, rel: rel === abs ? "" : rel, abs };
}

/**
 * Group `items` by root: the main project first, attached projects in their
 * order, "Other" last. Empty groups are left out, so one group back means
 * the files all sit in one place and the caller can draw them as before.
 */
export function groupByRoot<T>(
  items: readonly T[],
  roots: readonly SessionRoot[],
  pathOf: (item: T) => string,
): RootGroup<T>[] {
  const byKey = new Map<string, T[]>();
  const rootByKey = new Map<string, SessionRoot | null>();
  for (const item of items) {
    const { root } = placeFile(pathOf(item), roots);
    const key = root ? root.path : OTHER_GROUP;
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
      rootByKey.set(key, root);
    }
    list.push(item);
  }
  const out: RootGroup<T>[] = [];
  for (const root of roots) {
    const list = byKey.get(root.path);
    if (list) out.push({ key: root.path, root, label: root.name, items: list });
  }
  const other = byKey.get(OTHER_GROUP);
  if (other) out.push({ key: OTHER_GROUP, root: null, label: "Other", items: other });
  return out;
}

/** True when the groups need headers: more than one, or the one is not the
 *  main project's. */
export function needsGroupHeaders(groups: readonly { root: SessionRoot | null }[]): boolean {
  return groups.length > 1 || (groups.length === 1 && groups[0].root?.kind !== "main");
}
