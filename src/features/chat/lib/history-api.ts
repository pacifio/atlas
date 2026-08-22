import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
