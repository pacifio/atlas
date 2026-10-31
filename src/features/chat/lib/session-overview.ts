// Derivations for the session Details card's Changes section.
//
// Pure, and over the chat store's own data — the rail asks the same thread the
// transcript does, from a different angle. Nothing here fetches, and nothing
// here is per-frame expensive: every pass is over `messages`, which is already
// the hot object, so each one is gated on the section actually being open.

import type { ChatMessage, TurnFile } from "@/types/agent";
import type { SessionFile } from "./session-files";
import { toRepoRelative } from "./open-turn-diff";

export interface ChangeTally {
  files: TurnFile[];
  added: number;
  removed: number;
  /** Files the thread only READ. Kept apart from the edits because a reader
   *  scanning "what did this change" is not asking about them, and a list that
   *  mixes the two is mostly noise on a long turn. */
  readCount: number;
}

const EMPTY_CHANGES: ChangeTally = Object.freeze({
  files: [],
  added: 0,
  removed: 0,
  readCount: 0,
});

/**
 * Every file the thread has edited, newest turn last, one entry per path.
 *
 * Built from the per-turn summaries (`ChatMessage.turnSummary.files`) rather
 * than from tool calls, because that is where the counted lines already live —
 * the store froze them at `turn_finished` and the transcript footer renders
 * the same numbers. A file edited across several turns appears once, with its
 * line counts summed: the question the rail answers is "what has this
 * conversation done to the repo", not "what happened in turn four".
 *
 * `live` is the running turn's scratch (`ChatSession.turnScratch.tools`), the
 * same records before they are frozen. The rail exists for the turn you are
 * watching, so it folds them in as they land; the summary only ever restates
 * them, which is why a turn's edits do not double when it ends.
 */
export function tallyChanges(
  messages: readonly ChatMessage[],
  live?: Readonly<Record<string, TurnFile>>,
): ChangeTally {
  const edits = new Map<string, TurnFile>();
  const reads = new Set<string>();
  const fold = (file: TurnFile) => {
    if (file.kind === "read") {
      reads.add(file.path);
      return;
    }
    const seen = edits.get(file.path);
    if (seen) {
      seen.added += file.added;
      seen.removed += file.removed;
      // "Created" survives: a file this thread created and then edited again
      // is still the thread's to have created, and git will report it as A.
      seen.created = seen.created || file.created;
    } else {
      edits.set(file.path, { ...file });
    }
  };
  for (const message of messages) {
    const files = message.turnSummary?.files;
    if (!files) continue;
    for (const file of files) fold(file);
  }
  if (live) for (const file of Object.values(live)) fold(file);
  if (edits.size === 0 && reads.size === 0) return EMPTY_CHANGES;

  const files = [...edits.values()];
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  // A path that was read and later edited is an edit; it must not be counted
  // in both, or the two numbers beside the section header disagree with the
  // list under it.
  for (const path of edits.keys()) reads.delete(path);
  return { files, added, removed, readCount: reads.size };
}

/** Whether the thread has edited anything at all — the cheap read that decides
 *  whether the Changes section has a body, without building the list. */
export function hasChanges(
  messages: readonly ChatMessage[],
  live?: Readonly<Record<string, TurnFile>>,
): boolean {
  for (const message of messages) {
    const files = message.turnSummary?.files;
    if (files?.some((f) => f.kind === "edit")) return true;
  }
  if (live) for (const f of Object.values(live)) if (f.kind === "edit") return true;
  return false;
}

/** One row of the rail's Changes list. */
export interface ChangeRow {
  /** Project-relative. */
  path: string;
  created: boolean;
  deleted: boolean;
  /** Git's letter for the change, when a source can say: the record knows
   *  whether the file existed before and whether it survives; a tool call
   *  knows whether it created the file. Absent when neither said (a tally
   *  from before tools reported `created`) — the row shows a file icon. */
  status?: "A" | "M" | "D";
  /** Absent when nothing counted the lines — a shell edit the recorder saw
   *  land but has no diff for. The row still says the file changed. */
  added?: number;
  removed?: number;
}

/**
 * The Changes list: the record's answer, with the renderer's counts laid over it.
 *
 * `recorded` is what Rust attributed to the session (`capture_session_files`)
 * — every file, however it was edited, because the recorder also watches the
 * tree around shell calls. `local` is what the renderer counted from tool
 * arguments: a strict subset of the files, but the only source of line counts
 * for a Write or an Edit, which the record holds as a patch only for some
 * agents. The union keeps a file the record has not written yet (capture is a
 * worker, a beat behind the delta) and a file the record alone knows about.
 *
 * Order is the record's — first touch first — with local-only rows after it.
 * Paths from tool arguments are absolute; the record's are project-relative,
 * and the join is on the latter.
 */
export function mergeChanges(
  recorded: readonly SessionFile[],
  local: ChangeTally,
  repoPath: string,
): ChangeRow[] {
  const rows = new Map<string, ChangeRow>();
  for (const f of recorded) {
    if (f.outOfRepo) continue;
    rows.set(f.path, {
      path: f.path,
      created: f.created,
      deleted: f.deleted,
      status: f.deleted ? "D" : f.created ? "A" : "M",
      ...(f.added !== null && f.removed !== null ? { added: f.added, removed: f.removed } : {}),
    });
  }
  for (const f of local.files) {
    const path = toRepoRelative(f.path, repoPath);
    const row = rows.get(path);
    if (row) {
      // The renderer counted this one from the agent's own arguments, which
      // is the figure the transcript footer shows; the two must agree.
      if (f.added > 0 || f.removed > 0) {
        row.added = f.added;
        row.removed = f.removed;
      }
      row.created = row.created || !!f.created;
      if (f.created && row.status === "M") row.status = "A";
    } else {
      rows.set(path, {
        path,
        created: !!f.created,
        deleted: false,
        ...(f.created === undefined ? {} : { status: f.created ? "A" : "M" }),
        added: f.added,
        removed: f.removed,
      });
    }
  }
  return [...rows.values()];
}

/** "+58 −26" over the rows that have counts, or "N files" when none do. */
export function changesStatus(rows: readonly ChangeRow[]): string {
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const r of rows) {
    if (r.added === undefined || r.removed === undefined) continue;
    counted = true;
    added += r.added;
    removed += r.removed;
  }
  if (counted && (added > 0 || removed > 0)) return formatDiffStat(added, removed);
  return rows.length > 0 ? `${rows.length} ${rows.length === 1 ? "file" : "files"}` : "";
}

/** "+58 −26", the shape git and every review surface uses. An empty string
 *  when nothing changed, so a caller can render the slot or not without
 *  testing two numbers. */
export function formatDiffStat(added: number, removed: number): string {
  if (added === 0 && removed === 0) return "";
  return `+${added} −${removed}`;
}

/**
 * The last turn that can be committed, if any.
 *
 * `repoAtTurn` is the gate: it records whether the project was a git
 * repository when the turn ENDED, which is the only honest answer available
 * later — a repo initialised since then has no claim on those edits, and one
 * removed since then cannot take them.
 */
export function committableTurn(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const summary = messages[i].turnSummary;
    if (!summary) continue;
    if (!summary.repoAtTurn) return null;
    return summary.files.some((f) => f.kind === "edit") ? messages[i] : null;
  }
  return null;
}
