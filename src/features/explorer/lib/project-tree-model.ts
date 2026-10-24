// The project file tree's model: a per-directory cache of listings, the set of
// expanded directories, and the flat row list the virtualizer draws, derived
// from those two.
//
// Why a plain class behind `useSyncExternalStore` rather than a store:
//
//  - Nothing in a row's identity changes when a folder opens. Each listing is
//    turned into row objects once and cached against the listing itself, so
//    flattening is concatenating cached arrays, and a row that was on screen
//    before an expand is the same object after it.
//  - Loads are batched. Every directory asked for in one tick goes out as ONE
//    `read_directories` call, so revealing `a/b/c/d.ts` (four listings) or a
//    watcher burst touching twenty folders costs one IPC round trip.
//  - It outlives the view. The model is cached per project root, so closing
//    the Files surface and opening a file tab keeps what was open.
//
// Paths are root-relative and `/`-separated, `""` being the root, as
// `read_directories` answers them.

import type { DirectoryListing, ProjectEntry, ProjectEntryKind } from "./fs-api";
import type { TreeSearchState } from "./tree-search";

/** One drawn row. Immutable and shared between flattens; see `rowsOf`. */
export interface TreeRowData {
  /** Root-relative. */
  path: string;
  name: string;
  depth: number;
  kind: ProjectEntryKind;
  ignored: boolean;
  /** Starts with a dot: hidden unless the user shows hidden files. */
  hidden: boolean;
  /**
   * A compacted chain of folders, each the only child of the one before:
   * every folder's path, outermost first, drawn as one row (`vendor /
   * engine`). The row itself is the innermost folder (its `path`, `name`
   * and `ignored`) at the outermost one's depth. Absent on a plain row.
   */
  chain?: readonly string[];
  /** A search hit, as opposed to a folder shown because a hit is below it. */
  match?: boolean;
}

export interface TreeSnapshot {
  /** Visible rows, depth-first, in listing order. */
  rows: readonly TreeRowData[];
  expanded: ReadonlySet<string>;
  /** Directories whose listing is being fetched for the first time. */
  loading: ReadonlySet<string>;
  /** Directories whose last fetch failed, with why. */
  errors: ReadonlyMap<string, string>;
  /** The root has answered at least once. */
  ready: boolean;
}

export type DirectoryReader = (root: string, paths: string[]) => Promise<DirectoryListing[]>;

/** Paths per `read_directories` call. A watcher burst or an expand-all can ask
 *  for thousands; the backend answers each call in one blocking task, so a
 *  bound keeps any one call short and lets the first answers paint. */
export const BATCH_SIZE = 128;

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every directory above `path`, root first: `a/b/c.ts` → `["", "a", "a/b"]`. */
export function ancestorsOf(path: string): string[] {
  const out = [""];
  let i = path.indexOf("/");
  while (i >= 0) {
    out.push(path.slice(0, i));
    i = path.indexOf("/", i + 1);
  }
  return out;
}

const depthOf = (path: string) => {
  let depth = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) depth++;
  return depth;
};

/**
 * A listing's rows, built once per listing object. Weak, so a listing replaced
 * by a refresh is collected with its rows.
 *
 * `lift` is how many levels the rows are drawn above their path's depth: the
 * links a compacted chain above them folded into one row. Nearly always 0;
 * each other value gets its own cached copy.
 */
const rowCache = new WeakMap<readonly ProjectEntry[], TreeRowData[]>();
const liftedCache = new WeakMap<readonly ProjectEntry[], Map<number, TreeRowData[]>>();
export function rowsOf(entries: readonly ProjectEntry[], lift = 0): TreeRowData[] {
  if (lift > 0) {
    let byLift = liftedCache.get(entries);
    if (!byLift) liftedCache.set(entries, (byLift = new Map()));
    let lifted = byLift.get(lift);
    if (!lifted) {
      lifted = rowsOf(entries).map((row) => ({ ...row, depth: row.depth - lift }));
      byLift.set(lift, lifted);
    }
    return lifted;
  }
  let rows = rowCache.get(entries);
  if (!rows) {
    rows = entries.map((entry) => {
      const name = nameOf(entry.path);
      return {
        path: entry.path,
        name,
        depth: depthOf(entry.path),
        kind: entry.kind,
        ignored: entry.ignored === true,
        hidden: name.startsWith("."),
      };
    });
    rowCache.set(entries, rows);
  }
  return rows;
}

/**
 * The one visible child of a loaded folder when that child is a folder too:
 * the next link of a compacted chain. Null when the folder is not loaded,
 * holds anything else, or holds nothing. Stops counting at the second child,
 * so a folder of thousands costs two steps.
 */
export function onlyChildFolder(
  entries: readonly ProjectEntry[] | undefined,
  showHidden: boolean,
): TreeRowData | null {
  if (!entries) return null;
  let only: TreeRowData | null = null;
  for (const row of rowsOf(entries)) {
    if (row.hidden && !showHidden) continue;
    if (only) return null;
    only = row;
  }
  return only?.kind === "directory" ? only : null;
}

/** Compacted rows, kept per innermost folder's row so a flatten that finds
 *  the same chain hands back the same object (`ProjectTreeRow` is memoised). */
const chainCache = new WeakMap<TreeRowData, TreeRowData>();

/** `head`'s row, compacted over the single-folder chain below it if it has
 *  one; `head` itself if not. */
function compacted(
  head: TreeRowData,
  childrenOf: (dir: string) => TreeRowData | null,
): TreeRowData {
  let tail = head;
  let chain: string[] | null = null;
  for (let next = childrenOf(tail.path); next; next = childrenOf(tail.path)) {
    chain ??= [head.path];
    chain.push(next.path);
    tail = next;
  }
  if (!chain) return head;
  const cached = chainCache.get(tail);
  // Same innermost row and the same outermost path means the same chain:
  // every link between is a prefix of the innermost path.
  if (cached && cached.chain![0] === head.path && cached.depth === head.depth) return cached;
  const row: TreeRowData = { ...tail, depth: head.depth, chain };
  chainCache.set(tail, row);
  return row;
}

/** A compacted row is open when every folder in its chain is. */
/** Index of the row showing `path`: its own, or a compacted row it is a
 *  link of. -1 when no row shows it. */
export function rowIndexOf(rows: readonly TreeRowData[], path: string): number {
  return rows.findIndex((r) => r.path === path || (r.chain?.includes(path) ?? false));
}

/**
 * For each compacted row, its outer links → the row's own path. A path that
 * was a row of its own (focused, selected) and has since been folded into a
 * chain, because its listing loaded or a refresh left it one child, maps to
 * the row now drawing it.
 */
export function chainOwners(rows: readonly TreeRowData[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of rows) {
    if (!row.chain) continue;
    for (const link of row.chain) if (link !== row.path) owners.set(link, row.path);
  }
  return owners;
}

export function chainOpen(row: TreeRowData, expanded: ReadonlySet<string>): boolean {
  if (!row.chain) return expanded.has(row.path);
  for (const path of row.chain) if (!expanded.has(path)) return false;
  return true;
}

/**
 * Depth-first flatten of what is open. A directory that is expanded but not
 * yet loaded contributes its own row only; its children follow once they land.
 * An expanded directory under a collapsed one stays expanded and stays hidden,
 * so reopening the parent restores the subtree as it was.
 *
 * A loaded folder whose only child is a folder is compacted with it into one
 * row (`vendor / engine`), as long as the chain goes; see `TreeRowData.chain`.
 */
export function flattenTree(
  listings: ReadonlyMap<string, readonly ProjectEntry[]>,
  expanded: ReadonlySet<string>,
  showHidden: boolean,
): TreeRowData[] {
  const out: TreeRowData[] = [];
  const childFolder = (dir: string) => onlyChildFolder(listings.get(dir), showHidden);
  const walk = (dir: string, lift: number) => {
    const entries = listings.get(dir);
    if (!entries) return;
    for (const entry of rowsOf(entries, lift)) {
      if (entry.hidden && !showHidden) continue;
      if (entry.kind !== "directory") {
        out.push(entry);
        continue;
      }
      const row = compacted(entry, childFolder);
      out.push(row);
      // The links a chain folds away lift everything below it as many levels.
      if (chainOpen(row, expanded)) walk(row.path, lift + (row.chain ? row.chain.length - 1 : 0));
    }
  };
  walk("", 0);
  return out;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

export class ProjectTreeModel {
  readonly root: string;
  private readonly read: DirectoryReader;

  private listings = new Map<string, readonly ProjectEntry[]>();
  private expanded: ReadonlySet<string> = EMPTY_SET;
  private loading: ReadonlySet<string> = EMPTY_SET;
  private errors: ReadonlyMap<string, string> = EMPTY_MAP;
  /** Loaded directories a refresh skipped because nothing of them was on
   *  screen; re-read the moment they are opened again. */
  private stale = new Set<string>();
  private showHidden: boolean;

  /** Directories queued for the next batch. */
  private queued = new Set<string>();
  private flushScheduled = false;
  /** Per directory: the promise for its outstanding fetch. */
  private inflight = new Map<string, Promise<void>>();
  /** Waiters for a queued (not yet sent) directory. */
  private waiting = new Map<string, Array<() => void>>();
  /** Per directory with a request out: its generation, so a slow stale
   *  answer never overwrites a fresher one. An entry lives only while its
   *  request is in flight; an answer with no entry (forgotten, superseded)
   *  is dropped. */
  private generation = new Map<string, number>();
  private nextGeneration = 0;

  private snapshot: TreeSnapshot | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(root: string, read: DirectoryReader, opts: { showHidden?: boolean } = {}) {
    this.root = root;
    this.read = read;
    this.showHidden = opts.showHidden ?? false;
  }

  // ── Subscription ──────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TreeSnapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        rows: flattenTree(this.listings, this.expanded, this.showHidden),
        expanded: this.expanded,
        loading: this.loading,
        errors: this.errors,
        ready: this.listings.has(""),
      };
    }
    return this.snapshot;
  };

  private changed() {
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  /** Stop answering: a model dropped from the cache ignores late responses. */
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  isLoaded(path: string): boolean {
    return this.listings.has(path);
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path);
  }

  /** The kind of a loaded entry, or `undefined` when its parent is not loaded. */
  kindOf(path: string): ProjectEntryKind | undefined {
    if (path === "") return "directory";
    const siblings = this.listings.get(parentOf(path));
    return siblings?.find((e) => e.path === path)?.kind;
  }

  /** Every loaded listing, for a search over what is already known. */
  listingMap(): ReadonlyMap<string, readonly ProjectEntry[]> {
    return this.listings;
  }

  get hiddenShown(): boolean {
    return this.showHidden;
  }

  /** Every loaded directory: what a refresh re-reads. */
  loadedDirectories(): string[] {
    return [...this.listings.keys()];
  }

  // ── Loading ───────────────────────────────────────────────────────────

  /**
   * Fetch `paths` (root-relative directories) in one batched call. Already
   * loaded ones are skipped unless `force`. Resolves when every one of them
   * has answered, failed or been superseded.
   */
  load(paths: readonly string[], opts: { force?: boolean } = {}): Promise<void> {
    const pending: Promise<void>[] = [];
    let addedLoading = false;
    for (const path of paths) {
      if (this.queued.has(path)) {
        pending.push(this.waitFor(path));
        continue;
      }
      const flight = this.inflight.get(path);
      if (flight && !opts.force) {
        pending.push(flight);
        continue;
      }
      if (!opts.force && this.listings.has(path)) continue;
      this.queued.add(path);
      if (!this.listings.has(path) && !this.loading.has(path)) {
        if (!addedLoading) this.loading = new Set(this.loading);
        (this.loading as Set<string>).add(path);
        addedLoading = true;
      }
      pending.push(this.waitFor(path));
    }
    if (addedLoading) this.changed();
    if (this.queued.size > 0 && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
    return Promise.all(pending).then(() => undefined);
  }

  private waitFor(path: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.waiting.get(path);
      if (list) list.push(resolve);
      else this.waiting.set(path, [resolve]);
    });
  }

  private flush() {
    this.flushScheduled = false;
    if (this.disposed) return;
    const paths = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const chunk = paths.slice(i, i + BATCH_SIZE);
      const generations = chunk.map((path) => {
        const gen = ++this.nextGeneration;
        this.generation.set(path, gen);
        return gen;
      });
      const request = this.read(this.root, chunk).then(
        (listings) => this.apply(chunk, generations, listings, null),
        (error: unknown) => this.apply(chunk, generations, [], String(error)),
      );
      for (const path of chunk) {
        // Taken now: a waiter that queues the same path again after this
        // point waits for that later request, not this one.
        const waiters = this.waiting.get(path) ?? [];
        this.waiting.delete(path);
        const done = request.then(() => {
          if (this.inflight.get(path) === done) this.inflight.delete(path);
          for (const resolve of waiters) resolve();
        });
        this.inflight.set(path, done);
      }
    }
  }

  private apply(
    paths: string[],
    generations: number[],
    answers: DirectoryListing[],
    failure: string | null,
  ) {
    if (this.disposed) return;
    const byPath = new Map(answers.map((a) => [a.path, a]));
    let touched = false;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      if (this.generation.get(path) !== generations[i]) continue; // superseded or forgotten
      this.generation.delete(path);
      if (this.loading.has(path)) {
        const loading = new Set(this.loading);
        loading.delete(path);
        this.loading = loading;
        touched = true;
      }
      const answer = byPath.get(path);
      const error = failure ?? answer?.error ?? (answer ? null : `No listing for ${path || "/"}`);
      if (error) {
        // A folder that vanished takes its subtree with it; the error stays
        // on the folder itself, which its parent's next listing clears.
        if (path !== "" && this.listings.has(path)) {
          this.forget(path);
          touched = true;
        }
        // Recorded only while something still points at it: a folder its
        // loaded parent no longer lists is simply gone, and keeping an error
        // for every vanished path would grow the map for ever.
        if (this.isReferenced(path)) touched = this.setError(path, error) || touched;
        else touched = this.setError(path, null) || touched;
      } else {
        touched = this.setError(path, null) || touched;
        touched = this.replaceListing(path, answer!.entries) || touched;
      }
    }
    // Only a real change re-flattens. A watcher burst usually re-reads
    // folders whose listing came back identical; telling the view would
    // re-measure every row for nothing.
    if (touched) this.changed();
  }

  /** The root, or a path its parent's loaded listing (if any) still holds. */
  private isReferenced(path: string): boolean {
    if (path === "") return true;
    const siblings = this.listings.get(parentOf(path));
    return !siblings || siblings.some((e) => e.path === path);
  }

  /** Set or clear one directory's error. Answers whether anything changed. */
  private setError(path: string, error: string | null): boolean {
    const current = this.errors.get(path);
    if (error === null ? current === undefined : current === error) return false;
    const next = new Map(this.errors);
    if (error === null) next.delete(path);
    else next.set(path, error);
    this.errors = next;
    return true;
  }

  /**
   * Swap in a fresh listing, dropping cached subdirectories that are gone and
   * clearing the error of any that are back. Answers whether it changed.
   */
  private replaceListing(path: string, entries: ProjectEntry[]): boolean {
    const previous = this.listings.get(path);
    this.stale.delete(path);
    // A folder that failed (deleted) and is listed again (recreated) is fine,
    // whether or not the listing itself changed.
    let cleared = false;
    for (const e of entries) {
      if (e.kind === "directory" && this.errors.has(e.path)) {
        cleared = this.setError(e.path, null) || cleared;
      }
    }
    if (previous && sameEntries(previous, entries)) return cleared; // keep row identity
    if (previous) {
      const still = new Set<string>();
      for (const e of entries) if (e.kind === "directory") still.add(e.path);
      for (const e of previous) {
        if (e.kind === "directory" && !still.has(e.path)) this.forget(e.path);
      }
    }
    this.listings.set(path, entries);
    return true;
  }

  /**
   * Drop a directory and everything cached under it: listings, expansion,
   * errors, loading marks, and any answer still in flight for it.
   */
  private forget(path: string) {
    const prefix = `${path}/`;
    const under = (key: string) => key === path || key.startsWith(prefix);
    // Deleting the entry being visited is safe for a Map iterator.
    for (const key of this.listings.keys()) if (under(key)) this.listings.delete(key);
    for (const key of this.stale) if (under(key)) this.stale.delete(key);
    // A load still in flight for a dropped folder must not resurrect it:
    // with its generation gone, its answer reads as superseded.
    for (const key of this.generation.keys()) if (under(key)) this.generation.delete(key);
    const prune = <T extends ReadonlySet<string> | ReadonlyMap<string, unknown>>(
      from: T,
      copy: (from: T) => Set<string> | Map<string, unknown>,
    ): T => {
      let next: Set<string> | Map<string, unknown> | null = null;
      for (const key of from.keys()) {
        if (!under(key)) continue;
        next ??= copy(from);
        next.delete(key);
      }
      return (next ?? from) as T;
    };
    this.expanded = prune(this.expanded, (f) => new Set(f));
    this.loading = prune(this.loading, (f) => new Set(f));
    this.errors = prune(this.errors, (f) => new Map(f)) as ReadonlyMap<string, string>;
  }

  // ── Expansion ─────────────────────────────────────────────────────────

  expand(path: string): Promise<void> {
    return this.setExpanded([path], true);
  }

  collapse(path: string): void {
    void this.setExpanded([path], false);
  }

  /** Open or close a drawn row: a compacted one opens or closes its whole
   *  chain. */
  setRowExpanded(row: TreeRowData, open: boolean): Promise<void> {
    return this.setExpanded(row.chain ?? [row.path], open);
  }

  toggle(path: string): Promise<void> {
    return this.setExpanded([path], !this.expanded.has(path));
  }

  /**
   * Open or close several directories in one change and one batch.
   *
   * Opening a folder whose only child is a folder opens that one too, down
   * the chain: such a folder is drawn compacted with its child
   * (`flattenTree`), and a compacted row is open only when all of it is.
   * `cascade: false` skips that (expand-all opens everything anyway).
   */
  setExpanded(
    paths: readonly string[],
    open: boolean,
    opts: { cascade?: boolean } = {},
  ): Promise<void> {
    let next: Set<string> | null = null;
    for (const path of paths) {
      if (path === "" || this.expanded.has(path) === open) continue;
      next ??= new Set(this.expanded);
      if (open) next.add(path);
      else next.delete(path);
    }
    if (next) {
      this.expanded = next;
      this.changed();
    }
    if (!open) return Promise.resolve();
    const opening = paths.filter((p) => p !== "");
    // Folders a refresh skipped while hidden, now visible again.
    const stale: string[] = [];
    if (this.stale.size > 0) {
      for (const path of opening) this.collectVisibleStale(path, stale);
    }
    const loaded = Promise.all([
      this.load(opening.filter((p) => !this.stale.has(p))),
      stale.length > 0 ? this.load(stale, { force: true }) : undefined,
    ]).then(() => undefined);
    if (opts.cascade === false) return loaded;
    return loaded.then(() => {
      if (this.disposed) return;
      const next: string[] = [];
      for (const path of opening) {
        if (!this.expanded.has(path)) continue; // closed again meanwhile
        const child = onlyChildFolder(this.listings.get(path), this.showHidden);
        if (child && !this.expanded.has(child.path)) next.push(child.path);
      }
      return next.length > 0 ? this.setExpanded(next, true) : undefined;
    });
  }

  /** `dir` and every expanded folder showing below it that is stale. */
  private collectVisibleStale(dir: string, out: string[]) {
    if (!this.isVisibleDirectory(dir)) return;
    if (this.stale.has(dir)) out.push(dir);
    for (const e of this.listings.get(dir) ?? []) {
      if (e.kind === "directory" && this.expanded.has(e.path))
        this.collectVisibleStale(e.path, out);
    }
  }

  /** The root, or an expanded folder whose every ancestor is expanded: one
   *  whose children are rows on screen (or would be, scrolled to). */
  isVisibleDirectory(dir: string): boolean {
    if (dir === "") return true;
    if (!this.expanded.has(dir)) return false;
    for (const a of ancestorsOf(dir)) if (a !== "" && !this.expanded.has(a)) return false;
    return true;
  }

  collapseAll(): void {
    if (this.expanded.size === 0) return;
    this.expanded = EMPTY_SET;
    this.changed();
  }

  /**
   * Open every directory, loading as it goes, except ignored ones: an ignored
   * `node_modules` can hold tens of thousands of entries, so it still opens
   * by hand but never by this. Resolves when the walk is done; `signal` stops
   * it between levels.
   */
  async expandAll(signal?: AbortSignal): Promise<void> {
    await this.load([""]);
    let frontier = [""];
    while (frontier.length > 0 && !signal?.aborted && !this.disposed) {
      const dirs: string[] = [];
      for (const dir of frontier) {
        for (const e of this.listings.get(dir) ?? []) {
          if (e.kind !== "directory" || e.ignored) continue;
          if (!this.showHidden && nameOf(e.path).startsWith(".")) continue;
          dirs.push(e.path);
        }
      }
      if (dirs.length === 0) break;
      await this.setExpanded(dirs, true, { cascade: false });
      frontier = dirs;
    }
  }

  /**
   * Load and open every folder above `path` so its row is on screen. One
   * batch for the whole chain. Resolves with the row's index, or -1 when the
   * path is not there (deleted, hidden, outside the root).
   */
  async reveal(path: string): Promise<number> {
    if (!path) return -1;
    const ancestors = ancestorsOf(path);
    await this.load(ancestors);
    if (this.disposed) return -1;
    await this.setExpanded(ancestors, true);
    return this.indexOf(path);
  }

  /** The row showing `path`: its own, or the compacted row it is a link of. */
  indexOf(path: string): number {
    return rowIndexOf(this.getSnapshot().rows, path);
  }

  /** What the tree's search keeps for this root between views of it (the
   *  Files surface hands off to a file tab's tree mid-search), and the file
   *  this tree last opened, so that tab's reveal knows it came from here. */
  view: { search: TreeSearchState | null; openedFromTree: string | null } = {
    search: null,
    openedFromTree: null,
  };

  // ── Refresh ───────────────────────────────────────────────────────────

  /**
   * Re-read directories after a change on disk. With `dirs`, only those that
   * are loaded or failed (a watcher reports every folder it saw touched, most
   * of them never opened here); without, everything loaded.
   *
   * Only folders whose children are on screen are read now. A loaded folder
   * that is collapsed, or sits under a collapsed one, is marked stale and
   * read when it is next opened: a full refresh (every atomic save on macOS
   * is a rename, which the watcher cannot pin to a folder) must not re-read
   * every folder ever opened. Expansion survives either way.
   */
  refresh(dirs?: readonly string[]): Promise<void> {
    // A folder that failed is retried too: it may have been created since.
    const known = (d: string) => this.listings.has(d) || this.errors.has(d);
    const candidates = dirs
      ? dirs.filter(known)
      : [
          ...this.loadedDirectories(),
          ...[...this.errors.keys()].filter((d) => !this.listings.has(d)),
        ];
    if (!this.listings.has("") && (!dirs || dirs.includes(""))) candidates.push("");
    const now: string[] = [];
    for (const dir of candidates) {
      if (this.isVisibleDirectory(dir)) now.push(dir);
      else if (this.listings.has(dir)) this.stale.add(dir);
    }
    return this.load(now, { force: true });
  }

  setShowHidden(show: boolean): void {
    if (show === this.showHidden) return;
    this.showHidden = show;
    this.changed();
  }
}

function sameEntries(a: readonly ProjectEntry[], b: readonly ProjectEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.kind !== y.kind || (x.ignored ?? false) !== (y.ignored ?? false)) {
      return false;
    }
  }
  return true;
}

// ── One model per project root ──────────────────────────────────────────

/** Roots whose model is kept. Switching between a few projects keeps each
 *  one's tree as it was; a long session through many does not keep them all. */
export const MAX_MODELS = 4;

const models = new Map<string, ProjectTreeModel>();

/** The model for `root`, created on first ask. The least recently asked-for
 *  root is dropped once more than `MAX_MODELS` are held. */
export function projectTreeModel(
  root: string,
  read: DirectoryReader,
  opts: { showHidden?: boolean } = {},
): ProjectTreeModel {
  let model = models.get(root);
  if (model) {
    // Most recently used goes last.
    models.delete(root);
  } else {
    model = new ProjectTreeModel(root, read, opts);
  }
  models.set(root, model);
  while (models.size > MAX_MODELS) {
    const [oldest] = models.keys();
    dropProjectTreeModel(oldest);
  }
  return model;
}

/**
 * Re-read what `root`'s tree has loaded after a change on disk, if a tree for
 * it is cached; never creates one. `dirs` are absolute (the watcher's); those
 * outside `root` are skipped, and without `dirs` everything loaded is re-read.
 *
 * The one place watcher events reach the tree, mounted or not: a model kept
 * for a project whose tree is not on screen stays current, so reopening Files
 * never shows what was there before.
 */
export function refreshProjectTree(root: string, dirs?: readonly string[]): void {
  const model = models.get(root);
  if (!model) return;
  if (!dirs) {
    void model.refresh();
    return;
  }
  const rel: string[] = [];
  for (const dir of dirs) {
    if (dir === root) rel.push("");
    else if (dir.startsWith(`${root}/`)) rel.push(dir.slice(root.length + 1));
  }
  if (rel.length > 0) void model.refresh(rel);
}

/** Drop a root's model (a project closed for good; tests). */
export function dropProjectTreeModel(root: string): void {
  models.get(root)?.dispose();
  models.delete(root);
}
