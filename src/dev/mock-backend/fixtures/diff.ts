// A tiny structured-diff engine for the mock backend.
//
// Rust builds `FileDiff` in `crates/atlas-gitdiff/src/engine.rs`: whole-file
// context, `-`/`+` blocks paired into `changed` rows with word-level `emph`
// spans, everything else left as `added` / `removed` / `context`. Hand-writing
// that row model per fixture is unreadable and drifts the moment a fixture file
// is edited, so the fakes hand this module two texts instead and get the same
// shape back.
//
// The pairing heuristic is deliberately simpler than delta's `infer_edits`
// (index-wise, gated on token similarity). It only has to produce a diff that
// is *representative* — added, removed, modified and context lines, with word
// spans inside the modified ones — not byte-identical to git's.

import type { DiffLineStatus } from "@/features/git/lib/git-diff-api";
import type {
  DiffFileStat,
  DiffFileStatus,
  DiffPreview,
  DiffSource,
} from "@/features/git/lib/git-review-api";

// The engine's structured row model. The app no longer reads it (the review
// diff parses unified patches), so it is the mock's own: the fakes derive the
// editor gutter's line status and their +/- counts from it.
type DiffLineKind = "context" | "added" | "removed" | "changed";
interface DiffSegment {
  text: string;
  emph: boolean;
}
interface DiffSide {
  lineNo: number;
  kind: DiffLineKind;
  segments: DiffSegment[];
}
interface DiffRow {
  left: DiffSide | null;
  right: DiffSide | null;
}
export interface FileDiff {
  path: string;
  language: string;
  isBinary: boolean;
  rows: DiffRow[];
  stats: { additions: number; deletions: number };
  changeBlocks: number[];
}

type LineOp = { kind: "eq" | "del" | "ins"; text: string };

/** Longest-common-subsequence line diff. O(n·m) — fixture files are tiny. */
function diffLines(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "del", text: a[i++] });
    } else {
      ops.push({ kind: "ins", text: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "ins", text: b[j++] });
  return ops;
}

/** Split into word / non-word runs — delta's default `--word-diff-regex`. */
function tokenize(line: string): string[] {
  return line.match(/\w+|\W+?/g) ?? [];
}

const isWord = (token: string) => /^\w+$/.test(token);

/** Share of `a`'s word tokens that also appear in `b`. Drives the pairing gate. */
function similarity(a: string, b: string): number {
  const left = tokenize(a).filter(isWord);
  const right = tokenize(b).filter(isWord);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const pool = [...right];
  let hits = 0;
  for (const token of left) {
    const at = pool.indexOf(token);
    if (at !== -1) {
      pool.splice(at, 1);
      hits++;
    }
  }
  return (2 * hits) / (left.length + right.length);
}

function mergeSegments(parts: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const last = out[out.length - 1];
    if (last && last.emph === part.emph) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

function plainSegments(line: string): DiffSegment[] {
  return line ? [{ text: line, emph: false }] : [];
}

/**
 * Word-level spans for one half of a modified line: tokens outside the
 * token-level LCS are the change, and are marked `emph`.
 */
function emphSegments(line: string, counterpart: string): DiffSegment[] {
  const parts: DiffSegment[] = [];
  for (const op of diffLines(tokenize(line), tokenize(counterpart))) {
    // `ins` tokens belong to the counterpart, not to this half of the row.
    if (op.kind === "eq") parts.push({ text: op.text, emph: false });
    else if (op.kind === "del") parts.push({ text: op.text, emph: isWord(op.text) });
  }
  return mergeSegments(parts);
}

/** Lowercased extension — exactly what Rust's `language_of` ships. */
export function languageOf(file: string): string {
  const name = file.split("/").pop() ?? file;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function side(lineNo: number, kind: DiffSide["kind"], segments: DiffSegment[]): DiffSide {
  return { lineNo, kind, segments };
}

/** The `FileDiff` Rust would return for these two texts. */
export function buildFileDiff(oldText: string, newText: string, file: string): FileDiff {
  const oldLines = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const newLines = newText.length ? newText.replace(/\n$/, "").split("\n") : [];
  const ops = diffLines(oldLines, newLines);

  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let oldNo = 1;
  let newNo = 1;

  for (let i = 0; i < ops.length;) {
    if (ops[i].kind === "eq") {
      const text = ops[i].text;
      rows.push({
        left: side(oldNo++, "context", plainSegments(text)),
        right: side(newNo++, "context", plainSegments(text)),
      });
      i++;
      continue;
    }
    // Collect the whole contiguous change block, then pair it up.
    const minus: string[] = [];
    const plus: string[] = [];
    while (i < ops.length && ops[i].kind !== "eq") {
      if (ops[i].kind === "del") minus.push(ops[i].text);
      else plus.push(ops[i].text);
      i++;
    }
    deletions += minus.length;
    additions += plus.length;
    for (let k = 0; k < Math.max(minus.length, plus.length); k++) {
      const m = k < minus.length ? minus[k] : null;
      const p = k < plus.length ? plus[k] : null;
      if (m !== null && p !== null && similarity(m, p) >= 0.4) {
        rows.push({
          left: side(oldNo++, "changed", emphSegments(m, p)),
          right: side(newNo++, "changed", emphSegments(p, m)),
        });
        continue;
      }
      if (m !== null) rows.push({ left: side(oldNo++, "removed", plainSegments(m)), right: null });
      if (p !== null) rows.push({ left: null, right: side(newNo++, "added", plainSegments(p)) });
    }
  }

  const changeBlocks: number[] = [];
  let inBlock = false;
  rows.forEach((row, idx) => {
    const changed = !(row.left?.kind === "context" && row.right?.kind === "context");
    if (changed && !inBlock) changeBlocks.push(idx);
    inBlock = changed;
  });

  return {
    path: file,
    language: languageOf(file),
    isBinary: false,
    rows,
    stats: { additions, deletions },
    changeBlocks,
  };
}

/** A binary file's diff: no rows, `isBinary` true (the viewer shows a notice). */
export function binaryFileDiff(file: string): FileDiff {
  return {
    path: file,
    language: languageOf(file),
    isBinary: true,
    rows: [],
    stats: { additions: 0, deletions: 0 },
    changeBlocks: [],
  };
}

/**
 * The same change as a unified-diff STRING, for the commands that ship raw
 * `git diff` output (`git_diff_all`, `git_diff_file`, `CommitDetail.diff`)
 * rather than the structured model.
 */
export function unifiedDiff(oldText: string, newText: string, file: string, context = 3): string {
  const oldLines = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const newLines = newText.length ? newText.replace(/\n$/, "").split("\n") : [];
  const ops = diffLines(oldLines, newLines);

  // Mark which ops belong to a hunk: any change, plus `context` lines around it.
  const keep = Array.from<boolean>({ length: ops.length }).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === "eq") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });

  const body: string[] = [];
  let oldNo = 1;
  let newNo = 1;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i].kind !== "ins") oldNo++;
      if (ops[i].kind !== "del") newNo++;
      i++;
      continue;
    }
    const oldStart = oldNo;
    const newStart = newNo;
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (i < ops.length && keep[i]) {
      const op = ops[i++];
      if (op.kind === "eq") {
        lines.push(` ${op.text}`);
        oldCount++;
        newCount++;
        oldNo++;
        newNo++;
      } else if (op.kind === "del") {
        lines.push(`-${op.text}`);
        oldCount++;
        oldNo++;
      } else {
        lines.push(`+${op.text}`);
        newCount++;
        newNo++;
      }
    }
    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines);
  }

  if (body.length === 0) return "";
  const from = oldLines.length ? `a/${file}` : "/dev/null";
  const to = newLines.length ? `b/${file}` : "/dev/null";
  return [`diff --git a/${file} b/${file}`, `--- ${from}`, `+++ ${to}`, ...body].join("\n") + "\n";
}

/** Editor-gutter classification, mirroring Rust's `line_status`. */
export function lineStatusOf(diff: FileDiff): DiffLineStatus {
  const out: DiffLineStatus = { added: [], changed: [], deletedBefore: [] };
  let pendingDelete = false;
  for (const row of diff.rows) {
    const right = row.right;
    if (!right) {
      pendingDelete = true;
      continue;
    }
    if (right.kind === "added") out.added.push(right.lineNo);
    else if (right.kind === "changed") out.changed.push(right.lineNo);
    else if (pendingDelete) out.deletedBefore.push(right.lineNo);
    pendingDelete = false;
  }
  return out;
}

// ── The review diff (`git_diff_preview`) ──────────────────────────────────

/** One changed file as a fixture knows it: `null` on a side that does not exist. */
export interface PreviewChange {
  path: string;
  before: string | null;
  after: string | null;
  status: DiffFileStatus;
  binary?: boolean;
}

/** Rust caps each source's patch near here, cutting at a file boundary. */
const PATCH_CAP = 120_000;

/** FNV-1a over the patch and the file list: stable, cheap, and enough to key on. */
function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function previewSource(
  kind: DiffSource["kind"],
  changes: PreviewChange[],
  baseRef: string | null,
  mergeBase: string | null,
): DiffSource {
  const files: DiffFileStat[] = [];
  let diff = "";
  let truncated = false;
  for (const change of changes) {
    let patch: string;
    let additions = 0;
    let deletions = 0;
    if (change.binary) {
      patch = `diff --git a/${change.path} b/${change.path}\nBinary files a/${change.path} and b/${change.path} differ\n`;
    } else {
      patch = unifiedDiff(change.before ?? "", change.after ?? "", change.path);
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
    }
    files.push({
      path: change.path,
      additions,
      deletions,
      status: change.status,
      ...(change.binary ? { binary: true } : {}),
      // Rust sends the file's mtime and size; a hash of its text is the same signal.
      ...(change.after !== null ? { sig: hashOf(change.after) } : {}),
    });
    if (truncated || diff.length + patch.length > PATCH_CAP) truncated = true;
    else diff += patch;
  }
  return {
    kind,
    baseRef,
    mergeBase,
    diff,
    diffHash: hashOf(diff + JSON.stringify(files)),
    truncated,
    files,
  };
}

/**
 * What `git_diff_preview` answers for a fake repository: the working tree,
 * then the branch range — which, with no commits of its own on the branch,
 * is the same change set against the base.
 */
export function diffPreviewOf(
  working: PreviewChange[],
  range: { baseRef: string; mergeBase: string; changes?: PreviewChange[] },
): DiffPreview {
  return {
    sources: [
      previewSource("working-tree", working, null, null),
      previewSource("branch-range", range.changes ?? working, range.baseRef, range.mergeBase),
    ],
  };
}
