// Shared Cross-Agent Memory (v2): the Memory panel's record. Loads one
// project's event log, every record entry and the review queue, and keeps
// them current. Scoped to one project at a time (the active project),
// reloaded via `load(projectPath)`.
//
// Live refresh: every write to shared memory emits `atlas:memory-changed`
// (payload: the scope root and the affected kinds). The store re-pulls the
// bound project on each one. The payload's root is the repository's main
// worktree, which the frontend cannot derive from the launch directory (a
// linked worktree lives elsewhere), so every change re-pulls. It is three
// cheap reads, and they are coalesced.
//
// Entries: every record entry with its provenance (source, agent) and
// confidence. The user can edit one (written as source `user`, confidence 1),
// give a verdict on it, or forget it; all go through the backend, which
// announces the change.
//
// Review: the queue is pulled with the record, so the Review tab's count is
// right before the tab is opened. It is read on its own: a queue that cannot
// be read says so in `reviewError`, never as an empty queue, and a record
// that cannot be read does not hide a queue that can. A review action runs,
// then the record is re-read whether it worked or not.
//
// Import: the user can pull the project's Claude auto-memory in. The preview
// writes nothing; only confirming (with the lines the user kept) writes.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";
import {
  sharedMemory,
  type ClaudeImportPreview,
  type MemoryEntry,
  type MemoryEvent,
  type ReviewQueue,
  type Verdict,
} from "../lib/shared-memory-api";

export const EMPTY_REVIEW: ReviewQueue = { candidates: [], merges: [], conflicts: [], dreams: [] };

/** Emitted by the backend after every write to a shared-memory scope. */
export const MEMORY_CHANGED_EVENT = "atlas:memory-changed";

interface MemoryChangedPayload {
  root: string;
  kinds: string[];
}

interface SharedMemoryStore {
  projectPath: string | null;
  events: MemoryEvent[];
  /** Every record entry, newest write first, with provenance + confidence. */
  entries: MemoryEntry[];
  loaded: boolean;
  /** Why the record (events and entries) could not be read; `null` once a
   *  read succeeds. A failed refresh keeps the last good record and leaves
   *  this alone. */
  error: string | null;
  /** What waits for the user: candidates, duplicates, contradictions and the
   *  nightly review's proposals. */
  review: ReviewQueue;
  /** Why the review queue could not be read, while it could not. */
  reviewError: string | null;
  actions: {
    load: (projectPath: string) => Promise<void>;
    refresh: () => Promise<void>;
    clear: () => Promise<void>;
    /** Rewrite an entry's content as the user. Throws on failure. */
    editEntry: (id: number, content: string) => Promise<void>;
    /** Forget (delete) an entry. Throws on failure. */
    forgetEntry: (id: number) => Promise<void>;
    /** Forget an entry and erase its history. Throws on failure. */
    purgeEntry: (id: number) => Promise<void>;
    /** The user's verdict on an entry. Throws on failure. */
    feedback: (id: number, verdict: Verdict) => Promise<void>;
    /** Run one review action against the bound project, then re-read the
     *  record whatever happened. Resolves to what the backend answered
     *  (`"obsolete"` for a proposal memory moved past); throws on failure. */
    reviewAction: (run: (projectPath: string) => Promise<unknown>) => Promise<unknown>;
    /** What importing Claude's auto-memory would write. Reads only. */
    previewClaudeImport: () => Promise<ClaudeImportPreview | null>;
    /** Import the previewed lines in `ids`; returns how many were written.
     *  Throws on failure. */
    importClaude: (ids: string[]) => Promise<number>;
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An older backend answers without `dreams`. */
function withDreams(queue: ReviewQueue | null): ReviewQueue {
  if (!queue) return EMPTY_REVIEW;
  return { ...EMPTY_REVIEW, ...queue, dreams: queue.dreams ?? [] };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, error: errorText(err) }),
  );
}

/** The record (events and entries) and the review queue for one project,
 *  each settled on its own. */
async function pull(projectPath: string) {
  const [events, entries, review] = await Promise.all([
    settle(sharedMemory.listEvents(projectPath)),
    settle(sharedMemory.listEntries(projectPath)),
    settle(sharedMemory.review(projectPath)),
  ]);
  const record =
    events.ok && entries.ok
      ? { ok: true as const, events: events.value ?? [], entries: entries.value ?? [] }
      : {
          ok: false as const,
          error: !events.ok ? events.error : (entries as { error: string }).error,
        };
  return {
    record,
    review: review.ok
      ? { review: withDreams(review.value), reviewError: null }
      : { reviewError: review.error },
  };
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;

/** One app-lifetime subscription, taken on the first load. The handler
 *  re-pulls whichever project is bound when the event arrives, so switching
 *  projects needs no re-subscribe. */
let subscription: Promise<unknown> | null = null;
function subscribe(onChange: () => void) {
  if (subscription) return;
  subscription = listen<MemoryChangedPayload>(MEMORY_CHANGED_EVENT, onChange).catch(() => {
    // No Tauri runtime (tests, a plain browser): manual refresh still works.
    subscription = null;
  });
}

export const useSharedMemoryStore = createSelectors(
  create<SharedMemoryStore>((set, get) => ({
    projectPath: null,
    events: [],
    entries: [],
    loaded: false,
    error: null,
    review: EMPTY_REVIEW,
    reviewError: null,
    actions: {
      load: async (projectPath) => {
        // Another project's record never shows under this one. The same
        // project, loaded again (the tab re-opened), keeps what it shows
        // while it re-reads.
        if (get().projectPath !== projectPath) {
          set({
            projectPath,
            events: [],
            entries: [],
            review: EMPTY_REVIEW,
            loaded: false,
            error: null,
            reviewError: null,
          });
        }
        subscribe(() => void get().actions.refresh());
        const { record, review } = await pull(projectPath);
        // Ignore a stale response if the project changed mid-flight.
        if (get().projectPath !== projectPath) return;
        set({
          ...(record.ok
            ? { events: record.events, entries: record.entries, error: null }
            : { events: [], entries: [], error: record.error }),
          ...review,
          ...(review.reviewError ? { review: EMPTY_REVIEW } : {}),
          loaded: true,
        });
      },
      refresh: async () => {
        // A burst of writes (an agent editing many files) becomes one pull in
        // flight plus at most one after it, never one pull per write.
        if (refreshing) {
          refreshAgain = true;
          return refreshing;
        }
        refreshing = (async () => {
          do {
            refreshAgain = false;
            const { projectPath } = get();
            if (!projectPath) return;
            const { record, review } = await pull(projectPath);
            if (get().projectPath !== projectPath) continue;
            // A failed read keeps the last good one.
            set({
              ...(record.ok
                ? { events: record.events, entries: record.entries, error: null, loaded: true }
                : {}),
              ...review,
            });
          } while (refreshAgain);
        })().finally(() => {
          refreshing = null;
        });
        return refreshing;
      },
      clear: async () => {
        const { projectPath } = get();
        if (!projectPath) return;
        await sharedMemory.clear(projectPath);
        if (get().projectPath !== projectPath) return;
        set({ events: [], entries: [], review: EMPTY_REVIEW });
      },
      editEntry: async (id, content) => {
        const { projectPath } = get();
        if (!projectPath) return;
        const edited = await sharedMemory.editEntry(projectPath, id, content);
        if (get().projectPath !== projectPath) return;
        set({ entries: get().entries.map((e) => (e.id === id ? edited : e)) });
        // The state view and event log changed too; memory-changed also
        // re-pulls, this covers a runtime that does not deliver it.
        await get().actions.refresh();
      },
      forgetEntry: async (id) => {
        const { projectPath } = get();
        if (!projectPath) return;
        await sharedMemory.forgetEntry(projectPath, id);
        if (get().projectPath !== projectPath) return;
        set({ entries: get().entries.filter((e) => e.id !== id) });
        await get().actions.refresh();
      },
      purgeEntry: async (id) => {
        const { projectPath } = get();
        if (!projectPath) return;
        await sharedMemory.purgeEntry(projectPath, id);
        if (get().projectPath !== projectPath) return;
        set({ entries: get().entries.filter((e) => e.id !== id) });
        await get().actions.refresh();
      },
      feedback: async (id, verdict) => {
        const { projectPath } = get();
        if (!projectPath) return;
        const updated = await sharedMemory.feedback(projectPath, id, verdict);
        if (get().projectPath !== projectPath) return;
        if (updated) set({ entries: get().entries.map((e) => (e.id === id ? updated : e)) });
        await get().actions.refresh();
      },
      reviewAction: async (run) => {
        const { projectPath } = get();
        if (!projectPath) return null;
        try {
          return await run(projectPath);
        } finally {
          await get().actions.refresh();
        }
      },
      previewClaudeImport: async () => {
        const { projectPath } = get();
        if (!projectPath) return null;
        return sharedMemory.previewClaudeImport(projectPath);
      },
      importClaude: async (ids) => {
        const { projectPath } = get();
        if (!projectPath) return 0;
        const written = await sharedMemory.confirmClaudeImport(projectPath, ids);
        await get().actions.refresh();
        return written;
      },
    },
  })),
);
