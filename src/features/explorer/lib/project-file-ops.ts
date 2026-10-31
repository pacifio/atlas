// What the project file tree does to the disk, and what has to follow each
// change elsewhere in the app: re-read the folders it touched, re-point the
// recent-files queue, and re-point or close any tab showing a file that moved
// or went away. Kept out of the component so every entry point (menu,
// keyboard, drag) runs the same sequence.

import { toast } from "sonner";
import { activeProjectId } from "@/features/projects/lib/active-project";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openFile } from "@/lib/open-file";
import {
  copyPath,
  createDirectory,
  createFile,
  deletePath,
  duplicatePath,
  readDirectory,
  renamePath,
  renameRecentFile,
} from "./fs-api";
import type { ProjectTreeModel } from "./project-tree-model";

/** Tab types whose `data.filePath` is a file on disk. */
const FILE_TAB_TYPES = new Set(["editor", "media", "svg", "pdf", "notebook", "unsupported"]);

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Absolute → root-relative, `""` for the root itself; null when outside. */
export function relativeTo(root: string, abs: string): string | null {
  if (abs === root) return "";
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
}

export function absoluteOf(root: string, rel: string): string {
  return rel ? `${root}/${rel}` : root;
}

/**
 * Why `name` cannot be a file or folder name, or null when it can. Refuses
 * what would not name one entry in the folder it was typed in: empty, `.`,
 * `..`, a path separator of either platform, or a control character.
 */
export function entryNameError(name: string): string | null {
  if (name.trim() === "") return "A name is required.";
  if (name === "." || name === "..") return `"${name}" is not a valid name.`;
  if (/[/\\]/.test(name)) return "A name can't contain / or \\.";
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return "A name can't contain control characters.";
  return null;
}

/**
 * Why `src` cannot be moved or copied into `destDir`, or null. A folder into
 * itself or anything below it would never finish copying (each pass copies
 * the copy) and cannot be moved at all.
 */
export function intoItselfError(src: string, destDir: string): string | null {
  return destDir === src || destDir.startsWith(`${src}/`)
    ? "Can't put a folder inside itself"
    : null;
}

/**
 * `name`, or `name copy`, `name copy 2`… — the first that `taken` does not
 * hold, keeping the extension last, as Finder does.
 */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} copy ${Date.now()}${ext}`;
}

/** A destination for `src` inside `destDir` that does not overwrite anything. */
async function destinationFor(src: string, destDir: string): Promise<string> {
  let taken: Set<string>;
  try {
    taken = new Set((await readDirectory(destDir, "")).map((e) => baseOf(e.path)));
  } catch {
    taken = new Set();
  }
  return `${destDir}/${freeName(baseOf(src), taken)}`;
}

function filesTabsAt(path: string) {
  return useLayoutStore
    .getState()
    .tabs.filter(
      (t) =>
        FILE_TAB_TYPES.has(t.type) &&
        typeof t.data.filePath === "string" &&
        (t.data.filePath === path || t.data.filePath.startsWith(`${path}/`)),
    );
}

export class ProjectFileOps {
  constructor(private readonly model: ProjectTreeModel) {}

  private get root() {
    return this.model.root;
  }

  /** Re-read the folders (absolute) a change touched. */
  private touched(...dirs: string[]) {
    const rels = dirs.map((d) => relativeTo(this.root, d)).filter((d): d is string => d !== null);
    return this.model.refresh(rels);
  }

  private fail(error: unknown) {
    toast.error(error instanceof Error ? error.message : String(error));
  }

  /** `name` inside `parentDir`, refused when it is not a plain name or would
   *  land outside the project. */
  private childPath(parentDir: string, name: string): string | null {
    const invalid = entryNameError(name);
    const path = `${parentDir}/${name}`;
    if (invalid || relativeTo(this.root, path) === null || relativeTo(this.root, path) === "") {
      toast.error(invalid ?? "That would land outside the project.");
      return null;
    }
    return path;
  }

  async createFile(parentDir: string, name: string): Promise<void> {
    const path = this.childPath(parentDir, name);
    if (!path) return;
    try {
      await createFile(path);
      await this.touched(parentDir);
      void openFile(path);
    } catch (e) {
      this.fail(e);
    }
  }

  async createFolder(parentDir: string, name: string): Promise<void> {
    const path = this.childPath(parentDir, name);
    if (!path) return;
    try {
      await createDirectory(path);
      await this.touched(parentDir);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Rename in place. Answers the new path, or null when nothing happened. */
  async rename(oldPath: string, name: string): Promise<string | null> {
    if (`${dirOf(oldPath)}/${name}` === oldPath) return null;
    const newPath = this.childPath(dirOf(oldPath), name);
    if (!newPath) return null;
    try {
      await renamePath(oldPath, newPath);
      this.followMove(oldPath, newPath);
      await this.touched(dirOf(oldPath));
      return newPath;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** Move `src` into `destDir`, never over an existing name. */
  async move(src: string, destDir: string): Promise<void> {
    const parent = dirOf(src);
    if (parent === destDir) return;
    const into = intoItselfError(src, destDir);
    if (into) {
      toast.error(into);
      return;
    }
    try {
      const dest = await destinationFor(src, destDir);
      await renamePath(src, dest);
      this.followMove(src, dest);
      await this.touched(parent, destDir);
    } catch (e) {
      this.fail(e);
    }
  }

  async copyInto(sources: readonly string[], destDir: string): Promise<void> {
    let copied = 0;
    for (const src of sources) {
      const into = intoItselfError(src, destDir);
      if (into) {
        toast.error(into);
        continue;
      }
      try {
        await copyPath(src, await destinationFor(src, destDir));
        copied++;
      } catch (e) {
        toast.error(`Couldn't copy ${baseOf(src)}: ${String(e)}`);
      }
    }
    if (copied > 0) await this.touched(destDir);
  }

  async paste(clipboard: { paths: string[]; isCut: boolean }, destDir: string): Promise<void> {
    if (!clipboard.isCut) return this.copyInto(clipboard.paths, destDir);
    for (const src of clipboard.paths) await this.move(src, destDir);
  }

  async duplicate(path: string): Promise<void> {
    try {
      await duplicatePath(path);
      await this.touched(dirOf(path));
    } catch (e) {
      this.fail(e);
    }
  }

  async delete(paths: readonly string[]): Promise<void> {
    const parents = new Set<string>();
    for (const path of paths) {
      try {
        await deletePath(path);
        parents.add(dirOf(path));
        const { closeTab } = useLayoutStore.getState().actions;
        for (const tab of filesTabsAt(path)) closeTab(tab.id);
      } catch (e) {
        this.fail(e);
        break;
      }
    }
    await this.touched(...parents);
  }

  /**
   * A file or folder moved: keep the mention picker's recents and every open
   * tab under it pointing at where it is now. Reopening (rather than editing
   * the tab) re-classifies, so a changed extension lands in the right viewer.
   */
  private followMove(from: string, to: string) {
    void renameRecentFile(from, to, activeProjectId()).catch(() => {});
    const stale = filesTabsAt(from);
    if (stale.length === 0) return;
    const { closeTab } = useLayoutStore.getState().actions;
    for (const tab of stale) {
      const old = tab.data.filePath as string;
      closeTab(tab.id);
      void openFile(to + old.slice(from.length));
    }
  }
}
