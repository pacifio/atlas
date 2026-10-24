// Turning a unified patch into what the diff viewer renders, and the keys that
// let it repaint only the files that changed.
//
// Everything here runs on the main thread, so none of it tokenizes: parsing a
// patch into hunks is linear and cheap, and highlighting is the worker pool's.

import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

/** A short stand-in for a text in a cache key: its length and two
 *  independent hashes, so a key need not hold (and compare) the text. */
export function textFingerprint(text: string): string {
  const a = fnv1a32(text).toString(36);
  const b = fnv1a32(text, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36);
  return `${text.length}:${a}:${b}`;
}

export type RenderablePatch =
  | { kind: "files"; files: FileDiffMetadata[] }
  | { kind: "raw"; text: string; reason: string };

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export function getDiffLineStat(files: ReadonlyArray<FileDiffMetadata>): DiffLineStat {
  const total = { additions: 0, deletions: 0 };
  for (const file of files) {
    for (const hunk of file.hunks) {
      total.additions += hunk.additionLines;
      total.deletions += hunk.deletionLines;
    }
  }
  return total;
}

/**
 * The parser keeps a partial patch's hunk starts in source-file coordinates,
 * but the virtualizer lays a partial file out as compact rows. Without this a
 * review diff reserves the height of every unchanged line between hunks.
 * `collapsedBefore` survives, so the "N unmodified lines" separator still reads
 * right.
 */
function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;
  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compact = { ...hunk, splitLineStart, unifiedLineStart };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compact;
  });
  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  };
}

/**
 * The file with its whitespace-only changes shown as context: each hunk is
 * rediffed with every line's whitespace taken out, so a line that only moved
 * its indentation reads as unchanged. For a patch that cannot be asked for
 * again with `-w` (a pull request's, which GitHub hands over as is). Line
 * numbers are untouched: a hunk keeps its ranges, only what in it counts as a
 * change moves.
 */
export function withoutWhitespaceChanges(file: FileDiffMetadata): FileDiffMetadata {
  let splitDelta = 0;
  let unifiedDelta = 0;
  const strip = (lines: readonly string[], from: number, count: number) =>
    lines
      .slice(from, from + count)
      .map((line) => `${line.replace(/\s/g, "")}\n`)
      .join("");
  const hunks = file.hunks.map((hunk) => {
    const filtered = parseDiffFromFile(
      {
        name: file.name,
        contents: strip(file.deletionLines, hunk.deletionLineIndex, hunk.deletionCount),
      },
      {
        name: file.name,
        contents: strip(file.additionLines, hunk.additionLineIndex, hunk.additionCount),
      },
      { context: Infinity },
    ).hunks[0];
    const next = {
      ...hunk,
      additionLines: filtered?.additionLines ?? 0,
      deletionLines: filtered?.deletionLines ?? 0,
      hunkContent: filtered
        ? filtered.hunkContent.map((content) => ({
            ...content,
            additionLineIndex: content.additionLineIndex + hunk.additionLineIndex,
            deletionLineIndex: content.deletionLineIndex + hunk.deletionLineIndex,
          }))
        : [
            {
              type: "context" as const,
              lines: hunk.additionCount,
              additionLineIndex: hunk.additionLineIndex,
              deletionLineIndex: hunk.deletionLineIndex,
            },
          ],
      splitLineStart: hunk.splitLineStart + splitDelta,
      unifiedLineStart: hunk.unifiedLineStart + unifiedDelta,
      splitLineCount: filtered?.splitLineCount ?? hunk.additionCount,
      unifiedLineCount: filtered?.unifiedLineCount ?? hunk.additionCount,
    };
    splitDelta += next.splitLineCount - hunk.splitLineCount;
    unifiedDelta += next.unifiedLineCount - hunk.unifiedLineCount;
    return next;
  });
  return {
    ...file,
    hunks,
    splitLineCount: file.splitLineCount + splitDelta,
    unifiedLineCount: file.unifiedLineCount + unifiedDelta,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:ignore-whitespace` } : {}),
  };
}

/**
 * `null` for an empty patch; `raw` when it does not parse as files, or parses
 * only in part (a bad hunk would otherwise be dropped without a word).
 *
 * Each file's highlight-cache key is its own content's
 * ({@link withContentCacheKey}), not the patch's: when one file of a live
 * diff changes, every other file keeps its cached tokens.
 */
export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  // Trimmed only to test for emptiness: a trailing context line is a lone
  // space, and trimming the patch itself would cut it.
  if (!patch || patch.trim().length === 0) return null;
  try {
    const parsed = parsePatchFiles(patch, cacheScope, true);
    const files = parsed
      .flatMap((p) => p.files)
      .map((file) => withContentCacheKey(compactPartialHunkOffsets(file), cacheScope));
    if (files.length > 0) return { kind: "files", files };
    return { kind: "raw", text: patch, reason: "Unsupported diff format. Showing raw patch." };
  } catch {
    return { kind: "raw", text: patch, reason: "Failed to parse patch. Showing raw patch." };
  }
}

/** The file's own path (git quotes odd names; the parser decodes them). */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name ?? fileDiff.prevName ?? "";
}

export function resolveFileDiffPreviousPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevName ?? fileDiff.name ?? "";
}

/** A type change (file → symlink) arrives as a deletion and an addition of one
 *  path, so the change type is part of the identity. */
export function buildFileDiffIdentityKey(fileDiff: FileDiffMetadata): string {
  return `${resolveFileDiffPreviousPath(fileDiff)}\u0000${resolveFileDiffPath(fileDiff)}\u0000${fileDiff.type}`;
}

function hashPart(
  hash: number,
  value: string | number | boolean | undefined,
  multiplier: number,
): number {
  const serialized = value === undefined ? "undefined" : String(value);
  return fnv1a32(
    serialized,
    fnv1a32(`${typeof value}:${serialized.length}:`, hash, multiplier),
    multiplier,
  );
}

/**
 * A version for one file's content, which changes only when this file does:
 * a viewer item keyed by it repaints alone.
 */
export function buildFileDiffContentVersion(fileDiff: FileDiffMetadata): number {
  return contentHash(fileDiff, FNV_OFFSET_BASIS_32, FNV_PRIME_32);
}

/**
 * A copy of `fileDiff` whose highlight-cache key is its own path and content.
 * Two independent hashes: a collision would paint one file's tokens on another.
 */
export function withContentCacheKey(fileDiff: FileDiffMetadata, scope: string): FileDiffMetadata {
  const primary = buildFileDiffContentVersion(fileDiff).toString(36);
  const secondary = contentHash(fileDiff, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER);
  return { ...fileDiff, cacheKey: `${scope}:${primary}:${secondary.toString(36)}` };
}

function contentHash(fileDiff: FileDiffMetadata, seed: number, multiplier: number): number {
  let hash = seed;
  const append = (value: string | number | boolean | undefined) => {
    hash = hashPart(hash, value, multiplier);
  };
  append(fileDiff.name);
  append(fileDiff.prevName);
  append(fileDiff.lang);
  append(fileDiff.newObjectId);
  append(fileDiff.prevObjectId);
  append(fileDiff.mode);
  append(fileDiff.prevMode);
  append(fileDiff.type);
  append(fileDiff.isPartial);
  append(fileDiff.splitLineCount);
  append(fileDiff.unifiedLineCount);
  for (const line of fileDiff.additionLines) append(line);
  for (const line of fileDiff.deletionLines) append(line);
  for (const hunk of fileDiff.hunks) {
    append(hunk.collapsedBefore);
    append(hunk.additionStart);
    append(hunk.additionCount);
    append(hunk.additionLines);
    append(hunk.additionLineIndex);
    append(hunk.deletionStart);
    append(hunk.deletionCount);
    append(hunk.deletionLines);
    append(hunk.deletionLineIndex);
    append(hunk.hunkContext);
    append(hunk.hunkSpecs);
    append(hunk.splitLineStart);
    append(hunk.splitLineCount);
    append(hunk.unifiedLineStart);
    append(hunk.unifiedLineCount);
    append(hunk.noEOFCRAdditions);
    append(hunk.noEOFCRDeletions);
    for (const content of hunk.hunkContent) {
      append(content.type);
      append(content.additionLineIndex);
      append(content.deletionLineIndex);
      append(content.type === "change" ? content.additions : content.lines);
      append(content.type === "change" ? content.deletions : undefined);
    }
  }
  return hash;
}
