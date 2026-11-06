/**
 * Saving one open file: what is unsaved, writing the latest contents, and
 * never letting an older write report a newer edit as saved.
 *
 * Every edit is a revision. A write carries the revision it started from, and
 * only when no newer edit arrived meanwhile does the file stop being pending;
 * an edit made during a write gets a write of its own. Writes never overlap.
 *
 * Atlas saves on request (⌘S), so the default is manual: an edit only marks
 * the file pending and `flush()` writes it. Given `debounceMs`, the
 * coordinator instead writes on its own once edits settle, and flushes on
 * `dispose()`.
 */

export interface FileSaveCoordinatorOptions {
  /** `null`: write only on `flush()`. A number: write that long after the last edit. */
  readonly debounceMs: number | null;
  readonly canPersist?: () => boolean;
  /** Write `contents`; resolve `false` (or reject) when it did not land. */
  readonly persist: (contents: string) => Promise<boolean>;
  readonly onPendingChange: (pending: boolean) => void;
  /** Return false when another editor has newer unsaved contents. */
  readonly onConfirmed: (contents: string) => boolean | void;
}

export class FileSaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  /** The contents on disk as of the last confirmed write (or `reset`). */
  private confirmedContents: string | null = null;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private pending = false;
  /** Resolvers of `flush()` calls waiting for the write in flight. */
  private waiters: Array<(saved: boolean) => void> = [];
  /** The revision the latest `flush()` asked to have on disk. */
  private flushedRevision = 0;

  constructor(private readonly options: FileSaveCoordinatorOptions) {}

  /** The document is `contents` now. */
  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    // Edited back to what is on disk: nothing to save.
    if (contents === this.confirmedContents && !this.saving) {
      this.confirmedRevision = this.latestRevision;
      this.clearTimer();
      this.setPending(false);
      return;
    }
    this.setPending(true);
    if (this.options.debounceMs !== null) this.schedule(this.options.debounceMs);
  }

  /** The document was replaced from disk with `contents`: nothing is pending. */
  reset(contents: string): void {
    if (this.disposed) return;
    this.clearTimer();
    this.latestContents = contents;
    this.latestRevision += 1;
    this.confirmedRevision = this.latestRevision;
    this.confirmedContents = contents;
    this.setPending(false);
  }

  get isPending(): boolean {
    return this.pending;
  }

  /** Write the latest contents now. Resolves whether they are on disk. */
  flush(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.clearTimer();
    if (this.latestRevision === this.confirmedRevision && !this.saving) {
      return Promise.resolve(true);
    }
    this.flushedRevision = this.latestRevision;
    const settled = new Promise<boolean>((resolve) => this.waiters.push(resolve));
    void this.persistLatest();
    return settled;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    // A manual save never writes behind the user's back, closing included.
    if (this.options.debounceMs !== null && this.latestRevision > 0) void this.persistLatest();
    this.settleWaiters(false);
  }

  private setPending(pending: boolean): void {
    if (this.pending === pending) return;
    this.pending = pending;
    this.options.onPendingChange(pending);
  }

  private settleWaiters(saved: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(saved);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving) return;
    if (this.latestRevision === this.confirmedRevision) {
      this.settleWaiters(true);
      return;
    }
    if (this.options.canPersist?.() === false) {
      this.settleWaiters(false);
      return;
    }

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const succeeded = await this.options.persist(contents).catch(() => false);
    let confirmed = false;
    if (succeeded) {
      this.confirmedRevision = revision;
      this.confirmedContents = contents;
      confirmed = this.options.onConfirmed(contents) !== false;
    }

    this.saving = false;
    // Edited during the write, but back to exactly the bytes it wrote (an
    // undo, say): what is on disk is what is shown, so nothing is pending.
    const caughtUp = succeeded && this.latestContents === contents;
    if (revision === this.latestRevision || caughtUp) {
      if (caughtUp) {
        this.confirmedRevision = this.latestRevision;
        this.clearTimer();
      }
      if (confirmed) this.setPending(false);
      this.settleWaiters(succeeded);
      return;
    }

    // Edited during the write: still pending. A manual save wrote what was
    // asked for and stops there; an automatic one waits out what is left of
    // its debounce, or writes at once when disposed.
    if (this.options.debounceMs === null) {
      // A save asked for after this write began wants the newer contents.
      if (succeeded && this.flushedRevision > revision) void this.persistLatest();
      else this.settleWaiters(succeeded);
      return;
    }
    this.settleWaiters(succeeded);
    if (this.disposed) {
      void this.persistLatest();
      return;
    }
    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    this.schedule(remainingDebounce);
  }
}
