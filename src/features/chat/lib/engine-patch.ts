// The native engine's edit, read per file.
//
// The engine reports a file change as one ACP tool call of kind `edit` whose
// arguments are `{ paths, patch }` (`crates/atlas-native-agent/src/engine/
// sink.rs`, the `FileChange` arm). There is no `old_string`/`new_string` and
// no `diff` content block: `patch` is every changed file's own text, in
// `paths` order, joined with a newline. What each file contributes depends on
// what happened to it (`format_file_change_diff` in the engine):
//
// - an UPDATE is a headerless unified diff — hunks that start `@@ -a,b +c,d @@`,
//   then, for a rename, a blank line and `Moved to: <path>`;
// - an ADD is the new file's whole content, and a DELETE the old file's whole
//   content. Nothing in the text tells those two apart, so both read as a file
//   written out whole.
//
// The hunk headers carry their line counts, so an update's extent is exact and
// the next file starts right after it. A file's whole content has no such
// bound: it ends where the next file's hunks begin. Two whole-content files in
// a row cannot be told apart, so those come back `unknown`, with no text.
//
// Newer sessions carry `changes` beside them: `[{ path, kind, lines,
// movePath? }]`, one entry per file with what happened to it (`add`,
// `delete`, `update`, or `rename` to `movePath`) and the half-open range of
// `patch`'s lines that holds its text — a range rather than a copy, so no
// diff is carried twice. That answers both questions the joined text cannot,
// so it is read first; splitting `patch` is the fallback, for sessions
// recorded before it and for any entry that does not fit.

/** One file of a native edit. */
export interface EnginePatchFile {
  path: string;
  /** `hunks`: an update's unified diff. `content`: the file's whole text, as
   *  created (or, from `patch` alone, possibly deleted). `deleted`: the whole
   *  text of a file the edit removed; only `changes` can say so.
   *  `renamed`: a file moved to `movePath` with its content untouched.
   *  `unknown`: the text could not be split from its neighbour's. */
  shape: "hunks" | "content" | "deleted" | "renamed" | "unknown";
  /** The hunks, or the content; empty when `renamed` or `unknown`. */
  text: string;
  added: number;
  removed: number;
  /** Where a renamed file went. */
  movePath?: string;
}

/** The note the engine appends to a renamed file's diff. */
const MOVED_TO = "Moved to: ";

/**
 * Where the file went, when `lines[at]` starts a rename note — else null.
 *
 * The engine writes `{diff}\n\nMoved to: <path>`, and a diff ends in its own
 * newline, so the note is EXACTLY two blank lines, then `Moved to:`. One
 * blank line is only the join, and what follows it is the next file: an
 * added file whose first line reads "Moved to: x" is not a rename.
 */
function movedToAt(lines: readonly string[], at: number): string | null {
  if (lines[at] !== "" || lines[at + 1] !== "") return null;
  const note = lines[at + 2];
  return note?.startsWith(MOVED_TO) ? note.slice(MOVED_TO.length) : null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface HunkRun {
  /** Index of the line after the last hunk. */
  end: number;
  /** The hunks' lines, an empty context line given back its space. */
  lines: string[];
  added: number;
  removed: number;
}

/** Consume the hunks starting at `lines[pos]`, by their headers' counts. Null
 *  when the text there is not a well-formed run of hunks. */
function hunkRunAt(lines: readonly string[], pos: number): HunkRun | null {
  let i = pos;
  let added = 0;
  let removed = 0;
  let any = false;
  const out: string[] = [];
  while (i < lines.length) {
    const header = HUNK_HEADER.exec(lines[i]);
    if (!header) break;
    any = true;
    out.push(lines[i]);
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    i++;
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[i];
      if (line === undefined) return null;
      const mark = line[0];
      if (mark === "+") {
        newLeft--;
        added++;
      } else if (mark === "-") {
        oldLeft--;
        removed++;
      } else if (mark === " " || line === "") {
        // Some writers drop the space of an empty context line.
        oldLeft--;
        newLeft--;
      } else if (mark !== "\\") {
        return null;
      }
      out.push(line === "" ? " " : line);
      i++;
    }
    // "\ No newline at end of file" may follow a hunk's last line.
    while (lines[i]?.startsWith("\\")) out.push(lines[i++]);
  }
  return any ? { end: i, lines: out, added, removed } : null;
}

/** Lines in a whole text, as a diff counts them. */
function lineCount(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

const CHANGE_KINDS = new Set(["add", "delete", "update", "rename"]);

/** A `lines` range that fits a patch of `count` lines, at or after `floor`. */
function rangeOf(value: unknown, floor: number, count: number): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value as unknown[];
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const [s, e] = [start as number, end as number];
  return s >= floor && s <= e && e <= count ? [s, e] : null;
}

/**
 * The edit's `changes`, file by file, each sliced out of `patch` by its line
 * range — or null when there are none, or one entry is not the shape the
 * engine writes or its range does not fit (then `patch` is split instead).
 */
function fromChanges(changes: unknown, patch: string): EnginePatchFile[] | null {
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const patchLines = patch.split("\n");
  const out: EnginePatchFile[] = [];
  let floor = 0;
  for (const entry of changes) {
    if (!entry || typeof entry !== "object") return null;
    const { path, kind, lines: range, movePath } = entry as Record<string, unknown>;
    if (typeof path !== "string" || path === "") return null;
    if (typeof kind !== "string" || !CHANGE_KINDS.has(kind)) return null;
    const span = rangeOf(range, floor, patchLines.length);
    if (!span) return null;
    floor = span[1];
    const text = patchLines.slice(span[0], span[1]).join("\n");
    const moved = typeof movePath === "string" && movePath !== "" ? { movePath } : {};
    if (kind === "add") {
      out.push({ path, shape: "content", text, added: lineCount(text), removed: 0 });
    } else if (kind === "delete") {
      out.push({ path, shape: "deleted", text, added: 0, removed: lineCount(text) });
    } else if (kind === "rename" && "movePath" in moved && text.trim() === "") {
      // Moved, not edited: nothing to diff, and still a change to show.
      out.push({ path, shape: "renamed", text: "", added: 0, removed: 0, ...moved });
    } else {
      const run = hunkRunAt(text.split("\n"), 0);
      out.push(
        run
          ? {
              path,
              shape: "hunks",
              text: `${run.lines.join("\n")}\n`,
              added: run.added,
              removed: run.removed,
              ...moved,
            }
          : { path, shape: "unknown", text: "", added: 0, removed: 0, ...moved },
      );
    }
  }
  return out;
}

/**
 * The native engine's edit, file by file — or null when `args` is not that
 * shape. Every path comes back, in order; one whose text could not be split
 * out is `unknown`.
 */
export function enginePatchFiles(args: Record<string, unknown>): EnginePatchFile[] | null {
  const { paths, patch } = args;
  const structured = typeof patch === "string" ? fromChanges(args.changes, patch) : null;
  if (structured) return structured;
  if (typeof patch !== "string" || !Array.isArray(paths) || paths.length === 0) return null;
  if (!paths.every((p): p is string => typeof p === "string" && p.length > 0)) return null;
  if (patch.trim() === "") {
    // Still in flight, or the engine sent no text: the files, nothing more.
    return paths.map((path) => ({ path, shape: "unknown", text: "", added: 0, removed: 0 }));
  }

  const lines = patch.split("\n");
  const out: EnginePatchFile[] = [];
  let pos = 0;
  for (let f = 0; f < paths.length; f++) {
    const path = paths[f];
    const last = f === paths.length - 1;
    const run = HUNK_HEADER.test(lines[pos] ?? "") ? hunkRunAt(lines, pos) : null;
    if (run) {
      const file: EnginePatchFile = {
        path,
        shape: "hunks",
        text: `${run.lines.join("\n")}\n`,
        added: run.added,
        removed: run.removed,
      };
      out.push(file);
      // The diff's own trailing newline, then a rename note or the join's.
      const to = movedToAt(lines, run.end);
      if (to !== null) {
        if (to) file.movePath = to;
        pos = run.end + 3;
      } else pos = lines[run.end] === "" ? run.end + 1 : run.end;
      continue;
    }
    // A file moved and not edited: an empty diff, then its note.
    const moved = movedToAt(lines, pos);
    if (moved) {
      out.push({ path, shape: "renamed", text: "", added: 0, removed: 0, movePath: moved });
      pos += 3;
      continue;
    }
    if (last) {
      const text = lines.slice(pos).join("\n");
      out.push({ path, shape: "content", text, added: lineCount(text), removed: 0 });
      pos = lines.length;
      continue;
    }
    // Whole content runs to where the next file's hunks begin: a blank line
    // (the content's own last newline, then the join's), then a hunk header
    // that parses.
    let k = pos + 1;
    while (
      k < lines.length &&
      !(lines[k - 1] === "" && HUNK_HEADER.test(lines[k]) && hunkRunAt(lines, k))
    ) {
      k++;
    }
    if (k >= lines.length) {
      // The next file is whole content too: no boundary to find.
      for (let rest = f; rest < paths.length; rest++) {
        out.push({ path: paths[rest], shape: "unknown", text: "", added: 0, removed: 0 });
      }
      return out;
    }
    const text = `${lines.slice(pos, k - 1).join("\n")}\n`;
    out.push({ path, shape: "content", text, added: lineCount(text), removed: 0 });
    pos = k;
  }
  return out;
}

/** An update's hunks as the before/after text they show: context and removed
 *  lines, against context and added ones. An excerpt of the file. */
export function hunksExcerpt(hunks: string): { old: string; new: string } {
  const old: string[] = [];
  const neu: string[] = [];
  for (const line of hunks.split("\n")) {
    if (HUNK_HEADER.test(line) || line.startsWith("\\")) continue;
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "-") old.push(body);
    else if (mark === "+") neu.push(body);
    else if (mark === " ") {
      old.push(body);
      neu.push(body);
    }
  }
  const join = (xs: string[]) => (xs.length === 0 ? "" : `${xs.join("\n")}\n`);
  return { old: join(old), new: join(neu) };
}

/**
 * Apply an update's hunks to a whole text, or null when they do not fit it —
 * a context or removed line that is not where its header says.
 */
export function applyHunks(text: string, hunks: string): string | null {
  const endsWithNewline = text === "" || text.endsWith("\n");
  const src = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let cursor = 0;
  const lines = hunks.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = HUNK_HEADER.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    // A zero-length side names the line BEFORE the change.
    const at = oldCount === 0 ? oldStart : oldStart - 1;
    if (at < cursor || at > src.length) return null;
    for (; cursor < at; cursor++) out.push(src[cursor]);
    i++;
    let oldLeft = oldCount;
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[i];
      if (line === undefined) return null;
      const mark = line[0];
      const body = line.slice(1);
      if (mark === "+") {
        out.push(body);
        newLeft--;
      } else if (mark === "-" || mark === " " || line === "") {
        if (src[cursor] !== (line === "" ? "" : body)) return null;
        if (mark !== "-") {
          out.push(src[cursor]);
          newLeft--;
        }
        cursor++;
        oldLeft--;
      } else if (mark !== "\\") {
        return null;
      }
      i++;
    }
  }
  for (; cursor < src.length; cursor++) out.push(src[cursor]);
  if (out.length === 0) return "";
  return `${out.join("\n")}${endsWithNewline ? "\n" : ""}`;
}
