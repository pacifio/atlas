// A comment on lines of a diff or a file, as the session composer's chip
// carries it (`MentionReviewComment`, `review-comments.ts`).
//
// A picked range comes from the viewer as line numbers on a side (additions
// or deletions). For a diff the comment quotes the rows that range covers,
// as a small hunk (`@@ -a,b +c,d @@` and `+`/`-`/` ` lines), so the agent sees
// exactly what the reader saw, removed lines included; a file comment quotes
// the file's own lines. Rows are walked in the viewer's order: the hunks, and
// for a whole file the unchanged lines between them too, since an expanded
// diff shows those and a reader can pick them.

import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";

import type { MentionReviewComment } from "@/features/chat/lib/mentions";

interface DiffReviewLine {
  readonly change: "context" | "add" | "delete";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
}

/** What a comment is, before it has text and an id. */
export type ReviewCommentDraft = Omit<MentionReviewComment, "id" | "text">;

/** Where a comment was written, for the chip and for drawing it back. */
export interface ReviewSection {
  /** A diff scope's key, or `file:<abs path>`. */
  id: string;
  /** "Changes", "Uncommitted", "Turn 3", "File". */
  title: string;
}

const stripTrailingNewline = (value: string) => (value.endsWith("\n") ? value.slice(0, -1) : value);

function buildDiffReviewLines(
  fileDiff: FileDiffMetadata,
  includeExpandedContext: boolean,
  slice?: { readonly startIndex: number; readonly endIndex: number },
): DiffReviewLine[] {
  const rows: DiffReviewLine[] = [];
  let rowIndex = 0;
  let oldContextStart = 1;
  let newContextStart = 1;
  const pushRow = (row: DiffReviewLine) => {
    if (!slice || (rowIndex >= slice.startIndex && rowIndex <= slice.endIndex)) rows.push(row);
    rowIndex += 1;
  };
  const pushContextGap = (oldStart: number, newStart: number, lineCount: number) => {
    const count = Math.max(0, lineCount);
    const firstOffset = slice ? Math.max(0, slice.startIndex - rowIndex) : 0;
    const lastOffset = slice ? Math.min(count - 1, slice.endIndex - rowIndex) : count - 1;
    for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
      rows.push({
        change: "context",
        oldLineNumber: oldStart + offset,
        newLineNumber: newStart + offset,
        content: stripTrailingNewline(fileDiff.additionLines[newStart + offset - 1] ?? ""),
      });
    }
    rowIndex += count;
  };

  for (const hunk of fileDiff.hunks) {
    if (includeExpandedContext) {
      const oldHunkStart = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
      const newHunkStart = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
      pushContextGap(
        oldContextStart,
        newContextStart,
        Math.min(oldHunkStart - oldContextStart, newHunkStart - newContextStart),
      );
    }
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          pushRow({
            change: "context",
            oldLineNumber,
            newLineNumber,
            content: stripTrailingNewline(
              fileDiff.additionLines[additionLineIndex] ??
                fileDiff.deletionLines[deletionLineIndex] ??
                "",
            ),
          });
          oldLineNumber += 1;
          newLineNumber += 1;
          deletionLineIndex += 1;
          additionLineIndex += 1;
        }
        continue;
      }
      for (let index = 0; index < segment.deletions; index += 1) {
        pushRow({
          change: "delete",
          oldLineNumber,
          newLineNumber: null,
          content: stripTrailingNewline(fileDiff.deletionLines[deletionLineIndex] ?? ""),
        });
        oldLineNumber += 1;
        deletionLineIndex += 1;
      }
      for (let index = 0; index < segment.additions; index += 1) {
        pushRow({
          change: "add",
          oldLineNumber: null,
          newLineNumber,
          content: stripTrailingNewline(fileDiff.additionLines[additionLineIndex] ?? ""),
        });
        newLineNumber += 1;
        additionLineIndex += 1;
      }
    }
    oldContextStart = hunk.deletionStart + hunk.deletionCount;
    newContextStart = hunk.additionStart + hunk.additionCount;
    if (hunk.deletionCount === 0) oldContextStart += 1;
    if (hunk.additionCount === 0) newContextStart += 1;
  }

  if (includeExpandedContext) {
    pushContextGap(
      oldContextStart,
      newContextStart,
      Math.min(
        fileDiff.deletionLines.length - oldContextStart + 1,
        fileDiff.additionLines.length - newContextStart + 1,
      ),
    );
  }
  return rows;
}

/** The row index of `lineNumber` on `side`, falling back to the other side
 *  (a context row is on both); -1 when the diff does not show it. */
function findDiffReviewLineIndex(
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide | undefined,
  includeExpandedContext: boolean,
): number {
  const findOnSide = (selectedSide: "left" | "right") => {
    let rowIndex = 0;
    let oldContextStart = 1;
    let newContextStart = 1;
    const findContextIndex = (oldStart: number, newStart: number, lineCount: number) => {
      const count = Math.max(0, lineCount);
      const offset = lineNumber - (selectedSide === "left" ? oldStart : newStart);
      return offset >= 0 && offset < count ? rowIndex + offset : -1;
    };
    for (const hunk of fileDiff.hunks) {
      if (includeExpandedContext) {
        const oldContextEnd = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
        const newContextEnd = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
        const contextLines = Math.min(
          oldContextEnd - oldContextStart,
          newContextEnd - newContextStart,
        );
        const contextIndex = findContextIndex(oldContextStart, newContextStart, contextLines);
        if (contextIndex >= 0) return contextIndex;
        rowIndex += Math.max(0, contextLines);
      }
      let oldLineNumber = hunk.deletionStart;
      let newLineNumber = hunk.additionStart;
      for (const segment of hunk.hunkContent) {
        if (segment.type === "context") {
          const contextIndex = findContextIndex(oldLineNumber, newLineNumber, segment.lines);
          if (contextIndex >= 0) return contextIndex;
          rowIndex += segment.lines;
          oldLineNumber += segment.lines;
          newLineNumber += segment.lines;
          continue;
        }
        if (
          selectedSide === "left" &&
          lineNumber >= oldLineNumber &&
          lineNumber < oldLineNumber + segment.deletions
        ) {
          return rowIndex + lineNumber - oldLineNumber;
        }
        rowIndex += segment.deletions;
        oldLineNumber += segment.deletions;
        if (
          selectedSide === "right" &&
          lineNumber >= newLineNumber &&
          lineNumber < newLineNumber + segment.additions
        ) {
          return rowIndex + lineNumber - newLineNumber;
        }
        rowIndex += segment.additions;
        newLineNumber += segment.additions;
      }
      oldContextStart = hunk.deletionStart + hunk.deletionCount;
      newContextStart = hunk.additionStart + hunk.additionCount;
      if (hunk.deletionCount === 0) oldContextStart += 1;
      if (hunk.additionCount === 0) newContextStart += 1;
    }
    if (!includeExpandedContext) return -1;
    return findContextIndex(
      oldContextStart,
      newContextStart,
      Math.min(
        fileDiff.deletionLines.length - oldContextStart + 1,
        fileDiff.additionLines.length - newContextStart + 1,
      ),
    );
  };
  const selectedSide = side === "deletions" ? "left" : "right";
  const preferred = findOnSide(selectedSide);
  return preferred >= 0 ? preferred : findOnSide(selectedSide === "left" ? "right" : "left");
}

function diffRange(lines: readonly DiffReviewLine[], key: "oldLineNumber" | "newLineNumber") {
  const numbered = lines.filter((line) => line[key] !== null);
  return { start: numbered[0]?.[key] ?? 0, count: numbered.length };
}

const MARKER = { add: "+", delete: "-", context: " " } as const;

/** `+12 to +14` when every row is an addition (or `-` for removals), else the
 *  plain numbers, new side first. */
function formatDiffRangeLabel(lines: readonly DiffReviewLine[]): string {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return "line";
  const firstNumber = first.newLineNumber ?? first.oldLineNumber;
  const lastNumber = last.newLineNumber ?? last.oldLineNumber;
  if (firstNumber === null || lastNumber === null) {
    return lines.length === 1 ? "line" : `${lines.length} lines`;
  }
  const lead = MARKER[first.change].trim();
  const marker = lead && lines.every((line) => line.change === first.change) ? lead : "";
  return firstNumber === lastNumber
    ? `${marker}${firstNumber}`
    : `${marker}${firstNumber} to ${marker}${lastNumber}`;
}

/** `path:12` or `path:12-14`: the chip's label, written as the file view's
 *  line reference is. */
export function lineReference(filePath: string, start: number, end: number): string {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return `${filePath}:${from === to ? from : `${from}-${to}`}`;
}

/**
 * A comment on `range` of `fileDiff`: the rows it covers quoted as a small
 * hunk. Null when the range is not on rows the diff shows.
 */
export function buildDiffReviewComment(input: {
  section: ReviewSection;
  filePath: string;
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
}): ReviewCommentDraft | null {
  const { fileDiff, range } = input;
  const expanded = !fileDiff.isPartial;
  const startIndex = findDiffReviewLineIndex(fileDiff, range.start, range.side, expanded);
  const endIndex = findDiffReviewLineIndex(
    fileDiff,
    range.end,
    range.endSide ?? range.side,
    expanded,
  );
  if (startIndex < 0 || endIndex < 0) return null;
  const lines = buildDiffReviewLines(fileDiff, expanded, {
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
  });
  if (lines.length === 0) return null;
  const oldRange = diffRange(lines, "oldLineNumber");
  const newRange = diffRange(lines, "newLineNumber");
  const side = range.side ?? "additions";
  const endSide = range.endSide ?? side;
  return {
    kind: "review_comment",
    displayName: lineReference(input.filePath, range.start, range.end),
    sectionId: input.section.id,
    sectionTitle: input.section.title,
    filePath: input.filePath,
    rangeLabel: formatDiffRangeLabel(lines),
    diff: [
      `@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@`,
      ...lines.map((line) => `${MARKER[line.change]}${line.content}`),
    ].join("\n"),
    fenceLanguage: "diff",
    start: range.start,
    end: range.end,
    side,
    endSide,
  };
}

/** The fence language for a file's own lines: its extension, else `text`. */
export function inferFenceLanguage(filePath: string): string {
  const name = filePath.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1);
  if (name.startsWith(".") && name.length > 1) return name.slice(1);
  return "text";
}

/** `L12` or `L12 to L14`. */
export function formatFileRange(start: number, end: number): string {
  return start === end ? `L${start}` : `L${start} to L${end}`;
}

/** A comment on lines `startLine`–`endLine` (1-based, inclusive, either
 *  order) of a file whose text is `contents`. */
export function buildFileReviewComment(input: {
  section: ReviewSection;
  filePath: string;
  startLine: number;
  endLine: number;
  contents: string;
}): ReviewCommentDraft {
  const start = Math.max(1, Math.min(input.startLine, input.endLine));
  const end = Math.max(start, input.startLine, input.endLine);
  return {
    kind: "review_comment",
    displayName: lineReference(input.filePath, start, end),
    sectionId: input.section.id,
    sectionTitle: input.section.title,
    filePath: input.filePath,
    rangeLabel: formatFileRange(start, end),
    diff: input.contents
      .split("\n")
      .slice(start - 1, end)
      .join("\n"),
    fenceLanguage: inferFenceLanguage(input.filePath),
    start,
    end,
    side: "additions",
    endSide: "additions",
  };
}

/** The range a comment was written on, for the viewer to draw it back. */
export function reviewCommentRange(
  comment: Pick<MentionReviewComment, "start" | "end" | "side" | "endSide">,
): SelectedLineRange {
  return { start: comment.start, side: comment.side, end: comment.end, endSide: comment.endSide };
}
