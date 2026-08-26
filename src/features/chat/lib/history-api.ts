import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionKey } from "@/types/agents";

/**
 * Atlas's session history — the app-owned thread-metadata store (ADR-0001).
 *
 * History used to be assembled by reading each agent CLI's private storage and
 * re-reading it whenever a file changed. It is Atlas's own store now, and the
 * only refresh signal is the store saying it changed: no filesystem watching,
 * no polling.
 */

/** Fired whenever a thread row is added, changed or removed. */
export const THREADS_CHANGED_EVENT = "atlas:threads-changed";

/**
 * Re-run `onChange` whenever history changes.
 *
 * The event carries no payload on purpose — several changes can collapse into
 * one, and re-reading the store is the right response to any of them.
 */
export function onThreadsChanged(onChange: () => void): Promise<UnlistenFn> {
  return listen(THREADS_CHANGED_EVENT, () => onChange());
}

/** One thread, as every history surface renders it. */
export interface ThreadRow {
  threadId: string;
  /** Absent while the thread is a draft — nothing has been sent yet. */
  sessionId: string | null;
  /** Which agent ran it: the row's icon, and who resumes it. */
  agentId: string;
  /** Already resolved: the user's rename, else the agent's title, else the default. */
  title: string;
  updatedAt: string;
  createdAt: string | null;
  archived: boolean;
  projectName: string;
  folderPaths: string[];
}

/** One project's threads, as the sidebar groups them. */
export interface ThreadProject {
  /** Already disambiguated: qualified with the parent directory when another
   *  project shares its basename. */
  name: string;
  paths: string[];
  /** This is the project passed as `cwd`. Decided in Rust against canonicalised
   *  paths — never re-derive it here by comparing path strings, which is what
   *  used to fail whenever the two spellings differed. */
  isCurrent: boolean;
  threads: ThreadRow[];
}

/**
 * The open project's threads — the chat history sidebar's only source.
 *
 * Scoped to `cwd`: the store holds every project's threads, but Atlas switches
 * projects inside one window, so listing all of them here mixed unrelated
 * conversations into the sidebar. {@link threadHistory} is the unscoped view.
 *
 * Passing an empty `cwd` (no project open) returns every project, since there
 * is nothing to scope to.
 */
export function threadProjects(cwd: string): Promise<ThreadProject[]> {
  return invoke<ThreadProject[]>("threads_projects", { cwd: cwd || null });
}

/** Every thread, archived or not, newest-started first — the history view. */
export function threadHistory(archivedOnly = false): Promise<ThreadRow[]> {
  return invoke<ThreadRow[]>("threads_history", { archivedOnly });
}

/** A history row, now live. */
export interface ResumedThread {
  key: SessionKey;
  /**
   * The agent could only continue the session, not replay it — the old
   * messages are not coming back, and the user is told rather than left to
   * wonder where they went.
   */
  resumedWithoutHistory: boolean;
}

/**
 * Turn a history row into a live session: start the agent if it isn't running,
 * then `session/load` or `session/resume` by advertised capability.
 */
export function resumeThread(threadId: string): Promise<ResumedThread> {
  return invoke<ResumedThread>("threads_resume", { threadId });
}

/** Remove a history row. Always local; agent-side only when advertised. */
export function deleteThread(threadId: string): Promise<void> {
  return invoke<void>("threads_delete", { threadId });
}

/** Take a thread out of the active list, keeping it in history. */
export function archiveThread(threadId: string): Promise<void> {
  return invoke<void>("threads_archive", { threadId });
}

/** Whether an agent can be imported from, and why not when it cannot. */
export type ImportStatus =
  | { kind: "ready"; importable: number }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export interface ImportCandidate {
  pluginId: string;
  displayName: string;
  status: ImportStatus;
}

/**
 * Which installed agents can be imported from, and how much they have.
 *
 * Slow by nature: every installed agent is started to be asked, because the
 * capability only exists after `initialize`.
 */
export function importCandidates(): Promise<ImportCandidate[]> {
  return invoke<ImportCandidate[]>("threads_import_candidates");
}

/** Pull the chosen agents' sessions into history. Answers how many landed. */
export function importThreads(pluginIds: string[]): Promise<number> {
  return invoke<number>("threads_import", { pluginIds });
}
