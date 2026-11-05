// A pull request's patch as the diff panel's files, and the line arithmetic
// review threads need: whether a thread's line is in the diff at all, and
// which review position a gutter click names.
//
// The patch arrives a page at a time (`pr_diff`): whole while GitHub will
// send it whole, else a hundred files per page. Each page is parsed once
// and the parse lives as long as the page does, so a page arriving costs one
// parse rather than one per page already on screen.

import type { FileDiffMetadata, SelectionSide } from "@pierre/diffs";

import type { DiffFileStat, DiffFileStatus } from "@/features/git/lib/git-review-api";
import {
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
  withoutWhitespaceChanges,
} from "@/features/git/lib/diff-rendering";
import type { ReviewFile } from "@/features/git/lib/use-review-files";

import type {
  PrDiffFile,
  PrDiffResult,
  PrDiffSide,
  PrFileStatus,
  PrReviewPosition,
} from "./pull-requests-types";

/** One parsed file: as GitHub sent it (`source`, what review positions are
 *  counted in) and as shown (`file`, whitespace changes possibly hidden). */
export interface PrReviewFile extends ReviewFile {
  source: FileDiffMetadata;
}

/** A page's parse, whatever the whitespace mode: what the mode changes is
 *  derived from it (and cached) separately. */
interface PageParse {
  files: PrReviewFile[];
  /** The page did not parse as files: shown as text instead. */
  raw: string | null;
}

const parses = new WeakMap<PrDiffResult, PageParse>();
const hidden = new WeakMap<PrReviewFile, PrReviewFile>();

const STATUS_OF: Record<PrFileStatus, DiffFileStatus> = {
  added: "added",
  removed: "deleted",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  changed: "modified",
  unchanged: "modified",
};

function statusOfType(fileDiff: FileDiffMetadata): DiffFileStatus {
  switch (fileDiff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

function parsePage(page: PrDiffResult, scope: string): PageParse {
  const cached = parses.get(page);
  if (cached) return cached;
  const parsed = getRenderablePatch(page.patch, scope);
  const meta = new Map<string, PrDiffFile>(page.files.map((f) => [f.path, f]));
  const omitted = new Map(page.omittedFileStats.map((f) => [f.path, f]));
  const files: PrReviewFile[] =
    parsed?.kind === "files"
      ? parsed.files.map((fileDiff) => {
          const path = resolveFileDiffPath(fileDiff);
          const info = meta.get(path);
          const withheld = omitted.get(path);
          const counted = getDiffLineStat([fileDiff]);
          const stat: DiffFileStat = {
            path,
            ...(fileDiff.prevName && fileDiff.prevName !== path
              ? { oldPath: fileDiff.prevName }
              : {}),
            // The host's own counts: a file whose hunks it withheld would
            // otherwise read as an empty change.
            additions: info?.additions ?? withheld?.additions ?? counted.additions,
            deletions: info?.deletions ?? withheld?.deletions ?? counted.deletions,
            status: info ? STATUS_OF[info.status] : statusOfType(fileDiff),
          };
          const noHunks = fileDiff.hunks.length === 0 && fileDiff.type !== "rename-pure";
          return {
            stat,
            fileDiff,
            source: fileDiff,
            // No hunks for a change: past the host's patch limit if it
            // reported lines for it, else binary.
            state: noHunks
              ? withheld || (info && info.additions + info.deletions > 0)
                ? "too-large"
                : "binary"
              : "ready",
            truncated: false,
          } satisfies PrReviewFile;
        })
      : [];
  const result: PageParse = {
    files,
    raw: parsed?.kind === "raw" ? parsed.text : null,
  };
  parses.set(page, result);
  return result;
}

function withoutWhitespace(file: PrReviewFile): PrReviewFile {
  if (file.state !== "ready") return file;
  let next = hidden.get(file);
  if (!next) {
    next = { ...file, fileDiff: withoutWhitespaceChanges(file.source) };
    hidden.set(file, next);
  }
  return next;
}

export interface PrDiffFiles {
  files: PrReviewFile[];
  /** Pages that came back as unparseable text. */
  raw: string[];
  /** The host withheld some file's hunks (binary, or too large to inline). */
  withheld: boolean;
}

/** Every loaded page's files, in order, as the panel shows them. An unchanged
 *  page keeps its files' objects, so the viewer sees nothing new for them. */
export function prDiffFiles(
  pages: readonly PrDiffResult[],
  scope: string,
  ignoreWhitespace: boolean,
): PrDiffFiles {
  const files: PrReviewFile[] = [];
  const raw: string[] = [];
  const seen = new Set<string>();
  let withheld = false;
  for (const page of pages) {
    if (page.truncated) withheld = true;
    const parse = parsePage(page, scope);
    if (parse.raw !== null) raw.push(parse.raw);
    for (const file of parse.files) {
      if (seen.has(file.stat.path)) continue;
      seen.add(file.stat.path);
      if (file.state !== "ready") withheld = true;
      files.push(ignoreWhitespace ? withoutWhitespace(file) : file);
    }
  }
  return { files, raw, withheld };
}

/**
 * A thread naming a file is not the same as a thread the diff can show: its
 * line may have moved out of the change, or sit in a hunk the host withheld.
 * Pinning it anyway would put the remark against whatever code now holds
 * that line number, and dropping it would lose the conversation, so this
 * decides which of the two lists it belongs in.
 */
export function isLineInFileDiff(file: FileDiffMetadata, side: PrDiffSide, line: number): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

/** Where a line comment of the review in progress stands against the diff
 *  as loaded: on a line it shows; off it (its line left the change, or its
 *  file did), so GitHub would refuse the whole review; or not known yet (its
 *  file is on a page not read, or its hunks were withheld). */
export type PendingPlacement = "on" | "off" | "unknown";

export function pendingCommentPlacement(
  comment: { path: string; position: PrReviewPosition },
  filesByPath: ReadonlyMap<string, PrReviewFile>,
  /** Every page of the diff has been read. */
  complete: boolean,
): PendingPlacement {
  const file = filesByPath.get(comment.path);
  if (!file) return complete ? "off" : "unknown";
  if (file.state !== "ready") return "unknown";
  const { side, line } = positionAnchor(comment.position);
  return isLineInFileDiff(file.source, side, line) ? "on" : "off";
}

/** The comments `pendingCommentPlacement` puts off the diff. */
export function offDiffPendingComments<T extends { path: string; position: PrReviewPosition }>(
  comments: readonly T[],
  files: readonly PrReviewFile[],
  complete: boolean,
): T[] {
  if (comments.length === 0) return [];
  const byPath = new Map(files.map((f) => [f.stat.path, f]));
  return comments.filter((c) => pendingCommentPlacement(c, byPath, complete) === "off");
}

/** The viewer's name for a side. */
export function viewerSideOf(side: PrDiffSide): "deletions" | "additions" {
  return side === "left" ? "deletions" : "additions";
}

/** Where on the diff a review position sits: a line, and its side. */
export function positionAnchor(position: PrReviewPosition): { line: number; side: PrDiffSide } {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "right" };
    case "deleted":
      return { line: position.oldLine, side: "left" };
    case "context":
      return {
        line: position.side === "left" ? position.oldLine : position.newLine,
        side: position.side,
      };
  }
}

/**
 * The review position of one line the reader picked, counted in the patch
 * as the host sent it (`source`), or `null` where GitHub would refuse one: a
 * line outside every hunk (an expanded gap), or a number the hunks do not
 * hold on the side picked. An explicit side never falls back to the
 * same-numbered line on the other.
 */
export function resolveReviewPosition(
  file: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide | undefined,
): PrReviewPosition | null {
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        const onSide = side === "deletions" ? oldLine : newLine;
        const offset = lineNumber - onSide;
        if (offset >= 0 && offset < segment.lines) {
          return {
            kind: "context",
            oldLine: oldLine + offset,
            newLine: newLine + offset,
            side: side === "deletions" ? "left" : "right",
          };
        }
        oldLine += segment.lines;
        newLine += segment.lines;
        continue;
      }
      if (
        side !== "additions" &&
        lineNumber >= oldLine &&
        lineNumber < oldLine + segment.deletions
      ) {
        return { kind: "deleted", oldLine: lineNumber };
      }
      if (
        side !== "deletions" &&
        lineNumber >= newLine &&
        lineNumber < newLine + segment.additions
      ) {
        return { kind: "added", newLine: lineNumber };
      }
      oldLine += segment.deletions;
      newLine += segment.additions;
    }
  }
  return null;
}
