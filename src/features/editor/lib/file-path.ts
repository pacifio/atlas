// The file view's breadcrumb trail: the crumbs a path splits into, and the
// deeper trail the crumbs keep after the reader walks up from a file.
//
// A path is either project-relative (`/`-separated, `""` being the project
// root, as `read_directories` answers them) or, for a file outside the open
// project, an absolute host path in its platform's own spelling. Only a
// project-relative trail starts with the project's own crumb.

import type { ProjectEntry } from "@/features/explorer/lib/fs-api";
import { isUnderRoot, normalisePath } from "@/lib/file-links";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

function isWindowsAbsolutePath(value: string): boolean {
  return value.startsWith("\\\\") || /^[a-zA-Z]:([/\\]|$)/.test(value);
}

/** An absolute path on this machine, as opposed to one inside the project. */
export function isHostPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || isWindowsAbsolutePath(value);
}

export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isHostPath(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : relativePath.startsWith("/") ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      return {
        label: part,
        // A bare drive (`C:`) means the drive's current directory; its root is `C:\`.
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/**
 * `relativePath` written the way its own crumb names it, so a path with a
 * trailing or repeated separator still finds its crumb.
 */
export function breadcrumbPathOf(relativePath: string): string {
  const crumbs = fileBreadcrumbs("", relativePath);
  return crumbs[crumbs.length - 1]?.path ?? relativePath;
}

/**
 * Whether a host folder crumb names a directory that can be listed. A UNC
 * server (`\\server`) is not one; its shares (`\\server\share`) are.
 */
export function isListableHostFolder(path: string): boolean {
  return isHostPath(path) && !/^\\\\[^\\/]+$/.test(path);
}

/** Index of `path`'s crumb among `trail`'s crumbs; -1 when the trail does not pass through it. */
function trailCrumbIndex(trail: string, path: string): number {
  const crumbPath = breadcrumbPathOf(path);
  return fileBreadcrumbs("", trail).findIndex((crumb) => crumb.path === crumbPath);
}

/**
 * The deepest path the breadcrumbs keep showing after the reader moves to `path`.
 * Going up keeps the folders below visible so the way back down is one click;
 * moving anywhere else starts over at `path`.
 */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && trailCrumbIndex(trail, path) >= 0 ? trail : path;
}

/** The entry of `folder` that leads toward `trail`; null when the trail ends at the folder. */
export function trailChildOf(folder: string, trail: string): string | null {
  const index = trailCrumbIndex(trail, folder);
  return index < 0 ? null : (fileBreadcrumbs("", trail)[index + 1]?.label ?? null);
}

/** A folder's direct entries, folders first, in natural name order. */
export function fileBreadcrumbChildren(
  entries: readonly ProjectEntry[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .sort((left, right) => {
      if ((left.kind === "directory") !== (right.kind === "directory")) {
        return left.kind === "directory" ? -1 : 1;
      }
      collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      return collator.compare(left.label, right.label);
    });
}

/** The folder above a project-relative folder; null at the project root. */
export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}

/**
 * `path` relative to `root`, `/`-separated, or null when it is not strictly
 * inside it. Either may be written with `\` (a Windows path) or carry `.`/`..`
 * segments; both are normalised first.
 */
export function relativeToRoot(path: string, root: string): string | null {
  if (!path || !root) return null;
  const p = normalisePath(path);
  const r = normalisePath(root);
  if (!p || !r || p === r || !isUnderRoot(p, r)) return null;
  return p.slice(r.endsWith("/") ? r.length : r.length + 1);
}
