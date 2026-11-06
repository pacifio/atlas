import { invoke } from "@tauri-apps/api/core";
import { activeProjectId } from "@/features/projects/lib/active-project";

export interface FileMatch {
  path: string;
  rel: string;
}

export interface FileIndexStatus {
  indexed: boolean;
  count: number;
  root: string | null;
}

export interface FolderMatch {
  path: string;
  rel: string;
}

// Every call is scoped to the active project — multiple projects share
// one webview, so the backend can no longer infer which index to hit from the
// window label.
export const fileIndex = {
  openProject: (path: string) =>
    invoke<number>("fileindex_open_project", {
      path,
      workspaceId: activeProjectId(),
    }),
  closeProject: () =>
    invoke<void>("fileindex_close_project", {
      workspaceId: activeProjectId(),
    }),
  search: (query: string, limit = 100) =>
    invoke<FileMatch[]>("fileindex_search", {
      query,
      limit,
      workspaceId: activeProjectId(),
    }),
  searchDirs: (query: string, limit = 30) =>
    invoke<FolderMatch[]>("fileindex_search_dirs", {
      query,
      limit,
      workspaceId: activeProjectId(),
    }),
  status: () =>
    invoke<FileIndexStatus>("fileindex_status", {
      workspaceId: activeProjectId(),
    }),
};

/** Project roots whose index this session has asked the backend to open. */
const openedFor = new Set<string>();

/**
 * Search one named project's index, not the active one's: the file tree
 * beside a background project's file tab searches that project. The first
 * search per project opens its index (`fileindex_open_project` is idempotent
 * for a resident one and only walks when there is none).
 */
export async function searchProjectFiles(
  workspaceId: string,
  projectPath: string,
  query: string,
  limit: number,
): Promise<FileMatch[]> {
  if (!openedFor.has(projectPath)) {
    await invoke<number>("fileindex_open_project", { path: projectPath, workspaceId });
    openedFor.add(projectPath);
  }
  return invoke<FileMatch[]>("fileindex_search", { query, limit, workspaceId });
}

const FAIL_STATUS: FileIndexStatus = { indexed: false, count: 0, root: null };

// One in-flight (re)index shared across all callers (Cmd+P, the @-mention
// picker, the project-open effect) so a stuck/absent index is only rebuilt
// once even if several things ask for it at the same moment.
let reindexInFlight: Promise<FileIndexStatus> | null = null;
// Roots we have confirmed the backend holds a RESIDENT index for.
// `ensureFileIndex` can short-circuit with no IPC for any of them — keeps the
// per-keystroke mention path free. A SET, not a single root: the Rust side
// keeps one resident index per project (`fileindex_open_project` is
// idempotent for a live one), so switching A→B→A must not cost A its fast
// path — with a single slot, every switch made the first Cmd+P/@ in the
// returned-to project pay a status round-trip it didn't owe.
const confirmedRoots = new Set<string>();

/** (Re)open the backend index for `projectPath`. This is the single entry
 *  point for both the initial open and an explicit reindex — `fileindex_open_project`
 *  replaces whatever was there, re-walking the tree. */
export function openFileIndex(projectPath: string): Promise<FileIndexStatus> {
  reindexInFlight = fileIndex
    .openProject(projectPath)
    .then(async () => {
      const s = await fileIndex.status().catch(() => FAIL_STATUS);
      if (s.indexed && s.root) confirmedRoots.add(s.root);
      return s;
    })
    .catch(() => FAIL_STATUS)
    .finally(() => {
      reindexInFlight = null;
    });
  return reindexInFlight;
}

// Throttle for the fast path's background revalidation. The Rust side has its
// own (shorter) throttle; this one just keeps the per-keystroke ensure calls
// from firing an IPC each time.
const REVALIDATE_MS = 15_000;
const lastRevalidated = new Map<string, number>();

/** Make sure the project is indexed; if the backend has no (or a stale) index,
 *  trigger a reindex. Cheap when already confirmed (no IPC beyond a throttled
 *  background revalidate). Returns the status when it had to look, or `null`
 *  on the fast path. */
export async function ensureFileIndex(
  projectPath: string | null | undefined,
): Promise<FileIndexStatus | null> {
  if (projectPath && confirmedRoots.has(projectPath)) {
    // Fast path — but don't vouch for the index forever. A resident Rust
    // index can go stale (missed watcher event, dir created after the watch
    // plan); `fileindex_open_project` now does a throttled background
    // rebuild for resident indexes, so poke it occasionally, fire-and-forget.
    const now = Date.now();
    if ((lastRevalidated.get(projectPath) ?? 0) + REVALIDATE_MS <= now) {
      lastRevalidated.set(projectPath, now);
      void fileIndex.openProject(projectPath).catch(() => {});
    }
    return null;
  }
  if (reindexInFlight) return reindexInFlight;
  const status = await fileIndex.status().catch(() => FAIL_STATUS);
  if (status.indexed && (!projectPath || status.root === projectPath)) {
    if (status.root) confirmedRoots.add(status.root);
    return status;
  }
  if (!projectPath) return status;
  return openFileIndex(projectPath);
}

/** Forget every confirmed root — the project (window-level) closed. */
export function markFileIndexClosed(): void {
  confirmedRoots.clear();
  openedFor.clear();
}

/** Forget ONE root — its project's resident Rust index was torn down
 *  (project close / LRU eviction), so the fast path must not vouch for it. */
export function markFileIndexClosedFor(path: string): void {
  confirmedRoots.delete(path);
  openedFor.delete(path);
}

// ── Frontend cache of the file list ─────────────────────────────────────────
// Lets Cmd+P show instant results from the last good walk while a reindex runs,
// instead of a blank "Indexing files…" screen. Capped + per-project.
const CACHE_CAP = 1500;
const cacheKey = (p: string) => `atlas:fileindex-cache:${p}`;

export function cacheFileList(projectPath: string, files: FileMatch[]): void {
  try {
    localStorage.setItem(cacheKey(projectPath), JSON.stringify(files.slice(0, CACHE_CAP)));
  } catch {
    /* quota / serialization — cache is best-effort */
  }
}

export function getCachedFileList(projectPath: string): FileMatch[] {
  try {
    const raw = localStorage.getItem(cacheKey(projectPath));
    return raw ? (JSON.parse(raw) as FileMatch[]) : [];
  } catch {
    return [];
  }
}
