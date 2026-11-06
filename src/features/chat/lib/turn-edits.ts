import type { ChatMessage } from "@/types/agent";
import { getEditParts, getFilePathFromInput } from "./tool-files";
import { toRepoRelative } from "./open-turn-diff";
import { applyHunks, enginePatchFiles, hunksExcerpt } from "./engine-patch";
import { findTurnRun, isEmptyMessage, stableTurnKey, type TurnRun } from "./turn-identity";

/** What one turn did to one file. */
export interface TurnEdit {
  /** The text before, and after. For an excerpt, only the parts the edits
   *  named; for a `patch`, the hunks' own lines. */
  old: string;
  new: string;
  /**
   * The native engine's unified diff of the file, when that is the turn's
   * only edit to it: hunks with the file's real line numbers, which the
   * viewer renders as they are instead of diffing `old` against `new`. Empty
   * for a file the turn only moved: there is no diff to show.
   */
  patch?: string;
  /** The turn deleted the file. Said outright, because an empty file's
   *  deletion has no text either side to tell it by. */
  deleted?: true;
}

export interface TurnEdits {
  /** Files the turn changed, in the order it first touched them. */
  files: string[];
  /** Which file the viewer should land on. */
  initial: string;
  sources: Record<string, TurnEdit>;
  /**
   * Files whose pair is only the text the agent replaced, never the whole
   * file: an `Edit` names a fragment. Their diff is an excerpt, its line
   * numbers count from the fragment, and the viewer says so.
   */
  excerpts: ReadonlySet<string>;
  /** A renamed file's previous path, by the path it went to (the one in
   *  `files`). Absent when nothing was renamed. */
  renames?: Readonly<Record<string, string>>;
}

/** How one path's edits fold, as the turn's calls arrive in order. */
interface Fold {
  /** The whole file, before and after, while every edit so far has applied
   *  cleanly to a text the turn wrote out whole. Null once one did not. */
  pair: TurnEdit | null;
  /** Every edit's own text, concatenated: the answer when `pair` is lost. */
  concat: TurnEdit;
  /** `concat` holds a fragment, not only whole files. */
  fragmentary: boolean;
  /** The engine's hunks, kept while they are the path's only edit. */
  patch: string | null;
  edits: number;
  /** The last thing the turn did to the file was delete it. */
  deleted: boolean;
}

const newFold = (): Fold => ({
  pair: null,
  concat: { old: "", new: "" },
  fragmentary: false,
  patch: null,
  edits: 0,
  deleted: false,
});

/** A whole file written out. */
function foldWrite(f: Fold, content: string) {
  f.pair = f.edits === 0 ? { old: "", new: content } : f.pair && { ...f.pair, new: content };
  f.concat = { old: f.concat.old, new: f.concat.new + content };
  f.deleted = false;
  f.edits++;
}

/** A whole file removed, `content` being what it held. */
function foldDelete(f: Fold, content: string) {
  f.pair = f.edits === 0 ? { old: content, new: "" } : f.pair && { ...f.pair, new: "" };
  f.concat = { old: f.concat.old + content, new: f.concat.new };
  f.deleted = true;
  f.edits++;
}

/** A fragment replaced: applied to the whole file when the turn has it. */
function foldFragment(f: Fold, old: string, neu: string) {
  if (f.pair) {
    const at = f.pair.new.indexOf(old);
    f.pair =
      at < 0
        ? null
        : { ...f.pair, new: f.pair.new.slice(0, at) + neu + f.pair.new.slice(at + old.length) };
  }
  f.concat = { old: f.concat.old + old, new: f.concat.new + neu };
  f.fragmentary = true;
  f.edits++;
}

/** The engine's hunks: applied to the whole file when the turn has it. */
function foldHunks(f: Fold, hunks: string) {
  if (f.pair) {
    const applied = applyHunks(f.pair.new, hunks);
    f.pair = applied === null ? null : { ...f.pair, new: applied };
  }
  if (f.edits === 0) f.patch = hunks;
  const excerpt = hunksExcerpt(hunks);
  f.concat = { old: f.concat.old + excerpt.old, new: f.concat.new + excerpt.new };
  f.fragmentary = true;
  f.edits++;
}

/**
 * The before/after text a single turn produced, per file.
 *
 * Walks the turn's assistant run — `turnId` names any message of it, by its
 * transcript id or its stable key (`findTurnRun`) — and folds every edit a
 * tool call reported into one answer per path, so a turn that touched a file
 * three times reads as one diff rather than three competing ones.
 *
 * # Three shapes of edit, folded differently
 *
 * - **Diff blocks** (`acp::Diff`) carry the WHOLE FILE, before and after.
 *   Concatenating those produces nonsense: two edits to one file would give
 *   `old = v0 + v1` against `new = v1 + v2`. They fold by taking the FIRST
 *   block's before and the LAST block's after — the state the turn found the
 *   file in, and the state it left it in. A path reported this way takes this
 *   answer over any other: it is the complete file.
 * - **Arguments** carry a whole file (`Write`, an empty `old`) or a fragment
 *   (`Edit`). A fragment applied to a file this turn wrote out whole is
 *   applied for real (a string replace), so `Write` then `Edit` reads as the
 *   file the turn left. Otherwise fragments CONCATENATE into an excerpt — all
 *   the record holds — and the viewer says so.
 * - **The native engine's edit** (`{ paths, patch, changes? }`) carries each
 *   file's unified diff, a created file's whole content, or a deleted one's
 *   (`enginePatchFiles`). A file whose only edit is one diff renders that
 *   diff as it is, with real line numbers. A diff on a file this turn wrote
 *   whole is applied to it; several diffs to one file otherwise fold into an
 *   excerpt, like fragments. A deletion is its whole old text against
 *   nothing, so it reads as deleted.
 *
 * A file another agent deleted (`rm`, a command) contributes no edit at all
 * and simply does not appear: nothing recorded its text.
 */
export function collectTurnEdits(
  messages: ChatMessage[],
  turnId: string,
  repoPath: string,
  preferredFile?: string,
): TurnEdits {
  const run = findTurnRun(messages, turnId);
  /** Whole-file pairs, from diff blocks: first `old` wins, last `new` wins. */
  const whole: Record<string, TurnEdit> = {};
  const folds: Record<string, Fold> = {};
  const order: string[] = [];
  const renames: Record<string, string> = {};

  const see = (path: string) => {
    if (!order.includes(path)) order.push(path);
  };
  const foldOf = (path: string) => (folds[path] ??= newFold());
  /** A file the turn moved: whatever it already did to `from` carries on
   *  under `to`, in the same place in the list, so an edit and then a
   *  rename read as one file, not two. */
  const moveTo = (from: string, to: string) => {
    if (from === to) return;
    const origin = renames[from] ?? from;
    delete renames[from];
    if (origin !== to) renames[to] = origin;
    if (folds[from] && !folds[to]) folds[to] = folds[from];
    delete folds[from];
    if (whole[from] && !whole[to]) whole[to] = whole[from];
    delete whole[from];
    const at = order.indexOf(from);
    if (at >= 0) {
      if (order.includes(to)) order.splice(at, 1);
      else order[at] = to;
    }
  };

  for (let i = run?.start ?? 0; run && i < run.end; i++) {
    for (const tc of messages[i].toolCalls) {
      // An ACP agent may report its edit as a `diff` content block instead of
      // as recognisable arguments. Those carry the before/after text outright,
      // and are the ONLY record of an edit that is not on disk yet (plan mode,
      // preview), where a git-backed diff has nothing to compare against.
      for (const block of tc.contentBlocks ?? []) {
        if (block.type !== "diff") continue;
        const path = toRepoRelative(block.path, repoPath);
        see(path);
        const seen = whole[path];
        whole[path] = { old: seen ? seen.old : (block.oldText ?? ""), new: block.newText };
      }
      const args = tc.arguments ?? {};
      const parts = getEditParts(tc.toolName, args, tc.kind);
      if (parts.length > 0) {
        const abs = getFilePathFromInput(args);
        if (!abs) continue;
        const path = toRepoRelative(abs, repoPath);
        see(path);
        const fold = foldOf(path);
        for (const p of parts) {
          // A part with nothing before it is a whole file written out.
          if (p.old === "") foldWrite(fold, p.neu);
          else foldFragment(fold, p.old, p.neu);
        }
        continue;
      }
      for (const file of enginePatchFiles(args) ?? []) {
        if (file.shape === "unknown") continue;
        // A renamed file is shown where it went.
        const from = toRepoRelative(file.path, repoPath);
        const path = file.movePath ? toRepoRelative(file.movePath, repoPath) : from;
        if (file.movePath) moveTo(from, path);
        see(path);
        if (file.shape === "content") foldWrite(foldOf(path), file.text);
        else if (file.shape === "deleted") foldDelete(foldOf(path), file.text);
        else if (file.shape === "hunks") foldHunks(foldOf(path), file.text);
        else foldOf(path);
      }
    }
  }

  const sources: Record<string, TurnEdit> = {};
  const excerpts = new Set<string>();
  for (const path of order) {
    const fold = folds[path];
    if (whole[path]) sources[path] = whole[path];
    else if (fold.deleted && fold.pair) sources[path] = { ...fold.pair, deleted: true };
    else if (fold.pair) sources[path] = fold.pair;
    else if (fold.edits === 0) {
      // Moved, never edited: a rename with nothing to diff.
      sources[path] = { old: "", new: "", patch: "" };
    } else if (fold.edits === 1 && fold.patch !== null) {
      sources[path] = { ...fold.concat, patch: fold.patch };
    } else {
      sources[path] = fold.concat;
      if (fold.fragmentary) excerpts.add(path);
    }
  }

  // The row that was clicked may name the file by the path it had before
  // the turn renamed it.
  let wanted = preferredFile ? toRepoRelative(preferredFile, repoPath) : "";
  if (wanted && !sources[wanted]) {
    wanted = Object.keys(renames).find((to) => renames[to] === wanted) ?? wanted;
  }
  return {
    files: order,
    initial: wanted && sources[wanted] ? wanted : (order[0] ?? ""),
    sources,
    excerpts,
    ...(Object.keys(renames).length > 0 ? { renames } : {}),
  };
}

/** One turn of a session that changed files, as the turn picker lists it. */
export interface EditTurn {
  /** The turn's stable key (`stableTurnKey`), which outlives a reload of the
   *  log, unlike the transcript's `t:` id. */
  turnId: string;
  /** 1-based, counting every turn of the session, so a number stays put
   *  when an earlier turn changed nothing. */
  number: number;
  /** When the turn's last message arrived: when it finished, once it has. */
  timestamp: string;
  /** The prompt the turn answered, on one line; empty when there was none. */
  prompt: string;
  /** How many files it changed. */
  fileCount: number;
}

/** A prompt's snippet runs to this many characters before an ellipsis. */
export const PROMPT_SNIPPET_CHARS = 60;

/** The prompt's prose (without its @-mention context), on one line. */
function snippetOf(message: ChatMessage | undefined): string {
  if (!message || message.role !== "user") return "";
  const prose = (message.atlasProse ?? message.content).replace(/\s+/g, " ").trim();
  return prose.length > PROMPT_SNIPPET_CHARS
    ? `${prose.slice(0, PROMPT_SNIPPET_CHARS - 1).trimEnd()}…`
    : prose;
}

/** Add the paths one tool call edits to `paths`, by any shape
 *  `collectTurnEdits` reads. A rename replaces the path it moved from, as it
 *  does there. */
function addEditedPaths(
  paths: Set<string>,
  tc: ChatMessage["toolCalls"][number],
  repoPath: string,
) {
  for (const block of tc.contentBlocks ?? []) {
    if (block.type === "diff") paths.add(toRepoRelative(block.path, repoPath));
  }
  const args = tc.arguments ?? {};
  if (getEditParts(tc.toolName, args, tc.kind).length > 0) {
    const abs = getFilePathFromInput(args);
    if (abs) paths.add(toRepoRelative(abs, repoPath));
    return;
  }
  for (const file of enginePatchFiles(args) ?? []) {
    if (file.shape === "unknown") continue;
    if (file.movePath) paths.delete(toRepoRelative(file.path, repoPath));
    paths.add(toRepoRelative(file.movePath ?? file.path, repoPath));
  }
}

/**
 * Every turn of the session that changed a file, newest first.
 *
 * A turn is the run of assistant messages that answers a prompt, the same
 * run `collectTurnEdits` walks, so a listed turn always has edits to show. A
 * run of nothing but empty messages is no turn, as in the transcript.
 * Only paths are collected here; the texts are `collectTurnEdits`' job, for
 * the one turn the reader picks.
 */
export function listEditTurns(messages: ChatMessage[], repoPath: string): EditTurn[] {
  const out: EditTurn[] = [];
  let number = 0;
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role !== "assistant") {
      i++;
      continue;
    }
    const run: TurnRun = { start: i, end: i };
    const paths = new Set<string>();
    let shown = false;
    for (; i < messages.length && messages[i].role === "assistant"; i++) {
      if (!isEmptyMessage(messages[i])) shown = true;
      for (const tc of messages[i].toolCalls) {
        addEditedPaths(paths, tc, repoPath);
      }
    }
    run.end = i;
    if (!shown) continue;
    number += 1;
    const key = paths.size > 0 ? stableTurnKey(messages, run) : null;
    if (!key) continue;
    out.push({
      turnId: key,
      number,
      timestamp: messages[i - 1].timestamp,
      prompt: snippetOf(messages[run.start - 1]),
      fileCount: paths.size,
    });
  }
  return out.reverse();
}

/**
 * A cheap key that changes whenever a session's edits might have: a message
 * arrived, or any tool call was upserted, in whichever message
 * (`toolRevision`, which the store bumps). The last message's calls are in it
 * too, for a log changed without a delta (a test, a restore). Streamed prose
 * leaves it alone, so a view keyed on it does not re-render per chunk.
 */
export function editsSignature(
  messages: readonly ChatMessage[] | undefined,
  toolRevision = 0,
): string {
  if (!messages || messages.length === 0) return "";
  const last = messages[messages.length - 1];
  let calls = "";
  for (const tc of last.toolCalls) calls += `${tc.status[0]}${tc.contentBlocks?.length ?? 0}`;
  return `${messages.length}:${last.id}:${toolRevision}:${calls}`;
}
