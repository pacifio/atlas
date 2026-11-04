// Shared Cross-Agent Memory (v2): the Memory panel's record. Loads one
// project's derived state, its event log, every record entry and the review
// queue, and keeps them current. Scoped to one project at a time (the active
// project), reloaded via `load(projectPath)`.
//
// Live refresh: every write to shared memory emits `atlas:memory-changed`
// (payload: the scope root and the affected kinds). The store re-pulls the
// bound project on each one. The payload's root is the repository's main
// worktree, which the frontend cannot derive from the launch directory (a
// linked worktree lives elsewhere), so every change re-pulls. It is four
// cheap reads, and they are coalesced.
//
// Entries: every record entry with its provenance (source, agent) and
// confidence. The user can edit one (written as source `user`, confidence 1),
// give a verdict on it, or forget it; all go through the backend, which
// announces the change.
//
// Review: the queue is pulled with the record, so the Review tab's count is
// right before the tab is opened. A review action runs, then the record is
// re-read whether it worked or not.
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
  type SharedState,
  type Verdict,
} from "../lib/shared-memory-api";

const EMPTY_STATE: SharedState = {
  lastSeq: 0,
  activePlan: null,
  decisions: [],
  recentChanges: [],
  facts: [],
  failures: [],
  architecture: [],
  sessionAgents: {},
  updatedAt: 0,
};

export const EMPTY_REVIEW: ReviewQueue = { candidates: [], merges: [], conflicts: [], dreams: [] };

/** Emitted by the backend after every write to a shared-memory scope. */
export const MEMORY_CHANGED_EVENT = "atlas:memory-changed";

interface MemoryChangedPayload {
  root: string;
  kinds: string[];
}

interface SharedMemoryStore {
  projectPath: string | null;
  state: SharedState;
  events: MemoryEvent[];
  /** Every record entry, newest write first, with provenance + confidence. */
  entries: MemoryEntry[];
  loaded: boolean;
  /** Why the last load failed; `null` once a read succeeds. A failed
   *  refresh keeps the last good record and leaves this alone. */
  error: string | null;
  /** What waits for the user: candidates, duplicates, contradictions and the
   *  nightly review's proposals. */
  review: ReviewQueue;
  /** Why the review queue could not be read, while it could not. */
  reviewError: string | null;
  queryText: string;
  queryResults: MemoryEvent[];
  actions: {
    load: (projectPath: string) => Promise<void>;
    refresh: () => Promise<void>;
    runQuery: (query: string) => Promise<void>;
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

/** State, events, entries and the review queue for one project. Entries and
 *  the queue degrade on their own, so an older backend still shows the rest;
 *  a queue that fails to read keeps the last one and says why. */
async function pull(projectPath: string) {
  const [state, events, entries, review] = await Promise.all([
    sharedMemory.getState(projectPath),
    sharedMemory.listEvents(projectPath),
    sharedMemory.listEntries(projectPath).catch(() => [] as MemoryEntry[]),
    sharedMemory.review(projectPath).then(
      (queue) => ({ queue: withDreams(queue), error: null }),
      (err: unknown) => ({ queue: null, error: errorText(err) }),
    ),
  ]);
  return {
    state: state ?? EMPTY_STATE,
    events: events ?? [],
    entries: entries ?? [],
    ...(review.queue ? { review: review.queue } : {}),
    reviewError: review.error,
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
    state: EMPTY_STATE,
    events: [],
    entries: [],
    loaded: false,
    error: null,
    review: EMPTY_REVIEW,
    reviewError: null,
    queryText: "",
    queryResults: [],
    actions: {
      load: async (projectPath) => {
        // Another project's record never shows under this one.
        if (get().projectPath !== projectPath) {
          set({ state: EMPTY_STATE, events: [], entries: [], review: EMPTY_REVIEW });
        }
        set({ projectPath, loaded: false, error: null });
        subscribe(() => void get().actions.refresh());
        try {
          const pulled = await pull(projectPath);
          // Ignore a stale response if the project changed mid-flight.
          if (get().projectPath !== projectPath) return;
          set({ ...pulled, loaded: true, error: null });
        } catch (err) {
          if (get().projectPath !== projectPath) return;
          set({
            state: EMPTY_STATE,
            events: [],
            entries: [],
            loaded: true,
            error: errorText(err),
          });
        }
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
            try {
              const pulled = await pull(projectPath);
              if (get().projectPath !== projectPath) continue;
              set({ ...pulled, loaded: true, error: null });
            } catch {
              /* keep last good state */
            }
          } while (refreshAgain);
        })().finally(() => {
          refreshing = null;
        });
        return refreshing;
      },
      runQuery: async (query) => {
        const { projectPath } = get();
        set({ queryText: query });
        if (!projectPath || !query.trim()) {
          set({ queryResults: [] });
          return;
        }
        try {
          const queryResults = await sharedMemory.query(projectPath, query);
          if (get().projectPath !== projectPath) return;
          set({ queryResults });
        } catch {
          set({ queryResults: [] });
        }
      },
      clear: async () => {
        const { projectPath } = get();
        if (!projectPath) return;
        await sharedMemory.clear(projectPath);
        if (get().projectPath !== projectPath) return;
        set({
          state: EMPTY_STATE,
          events: [],
          entries: [],
          review: EMPTY_REVIEW,
          queryResults: [],
          queryText: "",
        });
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
