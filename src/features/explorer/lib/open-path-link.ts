// Opening a file a session names: a `@file` chip in a sent message, or a
// path an agent wrote in its reply (`markdown-render.ts` turns both into
// chips; `markdown-links.ts` routes their clicks here).
//
// Inside the open project the file becomes an Atlas tab, through the same
// open path as a click in the file tree, with the cursor on the line the chip
// named. So does a file under the root the chip was resolved against
// (`PathLink.root`): a session's working directory, which for a pull request
// session is a worktree under app data, not the open project. Every chip an
// agent wrote resolves under that root, so it opens in Atlas.
//
// Only a path the composer attached itself (`PathLink.trusted`) can go
// further: where a file opened from a diff goes (`open-review-file.ts`), the
// editor the user named, else the system's app, through the external-editor
// command, whose Rust side opens only document types and shows anything else
// in Finder. Any other chip outside every root — text an agent or a pull
// request wrote — is only revealed in the file manager: a click must never
// hand a planted `setup.terminal` to the system's opener. A folder (or a
// bundle such as `Foo.app`, a folder that reads like a file) is revealed too.
//
// Never the opener plugin's JS `openPath`: it is outside Atlas's capabilities,
// and it would skip that executable guard.

import { toast } from "sonner";
import { useAppStore } from "@/features/app/stores/app-store";
import { openOutsideFile } from "@/features/external-editor/lib/preferred-editor";
import { fileIndex } from "@/features/file-picker/lib/file-picker-api";
import {
  baseNameOf,
  isBundleName,
  isUnderRoot,
  normalisePath,
  resolveInProject,
} from "@/lib/file-links";
import { openInProject } from "./open-in-project";

/** What a chip carries. */
export interface PathLink {
  /** Absolute. */
  path: string;
  line?: number;
  column?: number;
  folder?: boolean;
  /** The root the chip was resolved under (the session's working directory). */
  root?: string;
  /** The composer attached this path itself: the user picked it. */
  trusted?: boolean;
}

/** `/` separators and an upper-case drive letter, for comparing index paths
 *  with a chip's whichever way either is written. */
function comparable(path: string): string {
  return normalisePath(path) ?? path;
}

/**
 * The file the project actually has at `path`, asked of the file index once,
 * at click time — never at render.
 *
 * An agent's path can be short of the project root (`api.ts:12`, or
 * `lib/api.ts` for `src/lib/api.ts`), which the renderer can only resolve
 * against the root. The index knows the real file: the exact path when it has
 * it, else the one file whose project-relative path ends with what was
 * written. Anything else — several candidates, no index, an error — keeps the
 * path as written, and the editor says if it is not there.
 */
export async function locateInProject(path: string, root: string): Promise<string> {
  const base = comparable(root).replace(/\/+$/, "");
  const full = comparable(path);
  const rel = full.slice(base.length + 1);
  if (!rel || !isUnderRoot(path, root)) return path;
  try {
    const matches = await fileIndex.search(rel, 50);
    if (matches.some((m) => comparable(m.path) === full)) return path;
    const tail = matches.filter((m) => {
      const r = m.rel.replace(/\\/g, "/");
      return r === rel || r.endsWith(`/${rel}`);
    });
    return tail.length === 1 ? tail[0].path : path;
  } catch {
    return path;
  }
}

async function revealInFileManager(path: string): Promise<void> {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (e) {
    toast.error("Couldn't show the folder", { description: String(e) });
  }
}

export async function openPathLink(link: PathLink): Promise<void> {
  if (link.folder || isBundleName(baseNameOf(link.path))) {
    // A folder has no tab to open in, and a bundle must never be run.
    await revealInFileManager(link.path);
    return;
  }
  const reveal =
    link.line === undefined ? undefined : { reveal: { line: link.line, column: link.column } };
  const root = useAppStore.getState().currentProject?.path ?? null;
  if (root && isUnderRoot(link.path, root)) {
    const path = await locateInProject(link.path, root);
    await openInProject(path, undefined, reveal);
    return;
  }
  // The session's own root (a worktree): Atlas's viewer, as in the project.
  // The file index covers the project only, so the path is taken as written.
  if (link.root && isUnderRoot(link.path, link.root)) {
    await openInProject(link.path, undefined, reveal);
    return;
  }
  if (link.trusted) {
    await openOutsideFile(link.path);
    return;
  }
  await revealInFileManager(link.path);
}

/** What a chip in text another person wrote carries. */
export interface UntrustedPathLink {
  /** Absolute, as the chip carries it. */
  path: string;
  line?: number;
  column?: number;
}

/**
 * Open a chip from text Atlas does not trust (a pull request's body and
 * comments, a plan, a note, a markdown file, a README, a team-chat message):
 * a file inside `root` becomes an Atlas tab, and nothing else happens. Never
 * the external editor, never the system's opener, never the file manager —
 * not even for a folder or a bundle — so a planted `setup.terminal` or
 * `Foo.app` cannot be launched from a click. A file Atlas cannot draw opens
 * as its "unsupported" tab, which runs nothing either.
 *
 * `root` is the surface's own (the checkout, the document's project), handed
 * in by the renderer, not read off the chip: whatever the DOM says, the path
 * is resolved again here and must land inside it. Resolves true when a tab
 * was opened.
 */
export async function openUntrustedPathLink(
  link: UntrustedPathLink,
  root: string,
): Promise<boolean> {
  const resolved = resolveInProject(link.path, root);
  if (!resolved || isBundleName(baseNameOf(resolved))) return false;
  const reveal =
    link.line === undefined ? undefined : { reveal: { line: link.line, column: link.column } };
  const project = useAppStore.getState().currentProject?.path ?? null;
  let path = resolved;
  if (project && isUnderRoot(resolved, project)) {
    const located = await locateInProject(resolved, project);
    // The index answers for the whole project; keep its answer only inside
    // the surface's root.
    if (isUnderRoot(located, root)) path = located;
  }
  await openInProject(path, undefined, reveal);
  return true;
}
