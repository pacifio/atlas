// The review panel across a session's roots: its own project, the projects
// attached to it (`session-roots.ts`), and "Other" for a turn's files outside
// all of them.
//
// Two halves.
//
// - The attached projects' working trees (`useAttachedRootReviews`). Each
//   attached project that is a git repository answers `git_diff_preview` as
//   the main project does — one call per root, in parallel, at most
//   `MAX_ATTACHED_ROOTS` of them — and each gets its own `useReviewFiles`, so
//   a large change there loads lazily exactly as the main project's does. The
//   slots are a fixed number of hook calls, which is what bounds them.
//
// - One list for the viewer (`combineReviews`). The viewer, the tree, the
//   viewed marks, find and the jump all key a file by its path, and two roots
//   can each have a `README.md`, so a file outside the main project is keyed
//   `<project> › <path in it>`: unique, and it reads as the project and the
//   path relative to its own root. A main-project file keeps its plain path,
//   so a session with nothing attached is keyed exactly as before. Each key
//   remembers where it came from (`ReviewKey`), so loading, retrying,
//   expanding context and opening the file go to the right repository.

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { FileDiffMetadata } from "@pierre/diffs";

import {
  OTHER_GROUP,
  ROOT_SEPARATOR,
  placeFile,
  type SessionRoot,
} from "@/features/chat/lib/session-roots";
import { getDiffPreview, type DiffFileStat, type DiffSource } from "./git-review-api";
import { useReviewFiles, type ReviewFile } from "./use-review-files";

/** Attached projects whose working trees the panel reads. Past it, the rest
 *  are left out: each is a `git diff` on every refresh. */
export const MAX_ATTACHED_ROOTS = 4;

export { ROOT_SEPARATOR };

type ReviewHook = ReturnType<typeof useReviewFiles>;

export interface AttachedRootReview {
  root: SessionRoot;
  /** `null` while loading, outside a repository, or when the scope is off. */
  source: DiffSource | null;
  review: ReviewHook;
}

/** Where a file the panel shows came from. */
export interface ReviewKey {
  /** The path its own source knows it by: git's, or the turn's. */
  orig: string;
  origOld?: string;
  /** Relative to its root; "Other" keeps the absolute path (`~` for home). */
  rel: string;
  abs: string;
  /** The group it is drawn under: a root's path, or `OTHER_GROUP`. */
  group: string;
  /** Index into the attached reviews; -1 for the main review (or the turn). */
  slot: number;
}

export interface ReviewGroup {
  key: string;
  label: string;
  root: SessionRoot | null;
  /** In the viewer's order. */
  stats: DiffFileStat[];
  additions: number;
  deletions: number;
}

export interface CombinedReview {
  files: ReviewFile[];
  stats: readonly DiffFileStat[];
  groups: ReviewGroup[];
  /** The groups need headers: more than one, or the one is not the main. */
  grouped: boolean;
  keys: ReadonlyMap<string, ReviewKey>;
  /** The key a path from outside (a jump, the card) is shown under. */
  keyOf: (path: string) => string;
}

const NO_ROOTS: readonly SessionRoot[] = [];

/**
 * The working-tree (or branch) review of each attached project that is a git
 * repository. `kind` null turns every call off (the turn scope reads no git).
 */
export function useAttachedRootReviews({
  roots,
  kind,
  ignoreWhitespace,
}: {
  roots: readonly SessionRoot[];
  kind: DiffSource["kind"] | null;
  ignoreWhitespace: boolean;
}) {
  const active = kind ? roots.slice(0, MAX_ATTACHED_ROOTS) : NO_ROOTS;
  // The main project's preview key, so a root opened as a project shares it.
  const previews = useQueries({
    queries: active.map((root) => ({
      queryKey: ["git-diff-preview", root.path, null, ignoreWhitespace],
      queryFn: () => getDiffPreview(root.path, { ignoreWhitespace }),
      staleTime: 2_000,
    })),
  });
  const sourceAt = (i: number): DiffSource | null =>
    kind ? (previews[i]?.data?.sources.find((s) => s.kind === kind) ?? null) : null;

  const rootsKey = active.map((r) => r.path).join("\0");

  // A fixed number of slots: hooks cannot be called in a loop over a list
  // that changes length. An unused slot has no source and asks for nothing.
  const s0 = useReviewFiles({
    repoPath: active[0]?.path ?? "",
    source: sourceAt(0),
    ignoreWhitespace,
  });
  const s1 = useReviewFiles({
    repoPath: active[1]?.path ?? "",
    source: sourceAt(1),
    ignoreWhitespace,
  });
  const s2 = useReviewFiles({
    repoPath: active[2]?.path ?? "",
    source: sourceAt(2),
    ignoreWhitespace,
  });
  const s3 = useReviewFiles({
    repoPath: active[3]?.path ?? "",
    source: sourceAt(3),
    ignoreWhitespace,
  });
  const slots = [s0, s1, s2, s3];
  const src = [sourceAt(0), sourceAt(1), sourceAt(2), sourceAt(3)];

  // New only when a root, a source or a slot's files change: the viewer's
  // list is rebuilt from it. A slot's callbacks are stable within its scope.
  const reviews = useMemo<AttachedRootReview[]>(
    () => active.map((root, i) => ({ root, source: src[i]!, review: slots[i]! })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootsKey, src[0], src[1], src[2], src[3], s0.files, s1.files, s2.files, s3.files],
  );
  return {
    reviews,
    isFetching: previews.some((p) => p.isFetching),
    refetch: () => {
      for (const p of previews) void p.refetch();
    },
  };
}

// ── One list for the viewer ────────────────────────────────────────────────

/** The same parsed diff under another name, one object per name, so a file
 *  that did not change keeps its identity (and its tokens) across renders. */
const renamed = new WeakMap<FileDiffMetadata, Map<string, FileDiffMetadata>>();
function relabel(fileDiff: FileDiffMetadata, name: string, prevName?: string): FileDiffMetadata {
  if (fileDiff.name === name && fileDiff.prevName === prevName) return fileDiff;
  let byName = renamed.get(fileDiff);
  if (!byName) {
    byName = new Map();
    renamed.set(fileDiff, byName);
  }
  const id = `${name}\0${prevName ?? ""}`;
  let out = byName.get(id);
  if (!out) {
    const { prevName: _prev, ...base } = fileDiff;
    out = prevName ? { ...base, name, prevName } : { ...base, name };
    byName.set(id, out);
  }
  return out;
}

/** Each root's label, with a repeated project name told apart. */
function labelsOf(roots: readonly SessionRoot[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const root of roots) {
    const n = (seen.get(root.name) ?? 0) + 1;
    seen.set(root.name, n);
    out.set(root.path, n === 1 ? root.name : `${root.name} (${n})`);
  }
  return out;
}

function keyFor(placed: ReturnType<typeof placeFile>, labels: ReadonlyMap<string, string>): string {
  if (!placed.root) return placed.rel;
  if (placed.root.kind === "main") return placed.rel;
  return `${labels.get(placed.root.path) ?? placed.root.name}${ROOT_SEPARATOR}${placed.rel}`;
}

interface Entry {
  file: ReviewFile;
  info: ReviewKey;
}

/**
 * The files of every source as the one list the viewer draws: the main
 * project's first, then each attached project's, then "Other", each re-keyed
 * as the header comment says.
 *
 * `main` is the main review's files (git, keyed by path in the main project)
 * or the turn's (keyed by the path the turn named: in the main project, or
 * absolute). `attached` adds each attached project's git review.
 */
export function combineReviews(
  main: readonly ReviewFile[],
  attached: readonly AttachedRootReview[],
  roots: readonly SessionRoot[],
): CombinedReview {
  // No project: nothing to place files against, so nothing is re-keyed.
  if (!roots.some((r) => r.kind === "main")) {
    const keys = new Map<string, ReviewKey>(
      main.map((f) => [
        f.stat.path,
        { orig: f.stat.path, rel: f.stat.path, abs: f.stat.path, group: OTHER_GROUP, slot: -1 },
      ]),
    );
    return {
      files: [...main],
      stats: main.map((f) => f.stat),
      groups: [],
      grouped: false,
      keys,
      keyOf: (path) => path,
    };
  }
  const labels = labelsOf(roots);
  const byGroup = new Map<string, Entry[]>();
  const push = (entry: Entry) => {
    let list = byGroup.get(entry.info.group);
    if (!list) {
      list = [];
      byGroup.set(entry.info.group, list);
    }
    list.push(entry);
  };

  for (const file of main) {
    const placed = placeFile(file.stat.path, roots);
    const key = keyFor(placed, labels);
    const old = file.stat.oldPath ? placeFile(file.stat.oldPath, roots) : null;
    const oldKey = old ? keyFor(old, labels) : undefined;
    push({
      file: rekey(file, key, oldKey),
      info: {
        orig: file.stat.path,
        ...(file.stat.oldPath ? { origOld: file.stat.oldPath } : {}),
        rel: placed.rel || placed.abs,
        abs: placed.abs,
        group: placed.root?.path ?? OTHER_GROUP,
        slot: -1,
      },
    });
  }
  attached.forEach(({ root, review }, slot) => {
    const label = labels.get(root.path) ?? root.name;
    for (const file of review.files) {
      const rel = file.stat.path;
      const key = `${label}${ROOT_SEPARATOR}${rel}`;
      const oldKey = file.stat.oldPath
        ? `${label}${ROOT_SEPARATOR}${file.stat.oldPath}`
        : undefined;
      push({
        file: rekey(file, key, oldKey),
        info: {
          orig: rel,
          ...(file.stat.oldPath ? { origOld: file.stat.oldPath } : {}),
          rel,
          abs: `${root.path}/${rel}`,
          group: root.path,
          slot,
        },
      });
    }
  });

  const files: ReviewFile[] = [];
  const groups: ReviewGroup[] = [];
  const keys = new Map<string, ReviewKey>();
  const emit = (groupKey: string, label: string, root: SessionRoot | null) => {
    const entries = byGroup.get(groupKey);
    if (!entries) return;
    let additions = 0;
    let deletions = 0;
    const stats: DiffFileStat[] = [];
    for (const { file, info } of entries) {
      // A key two sources share (a turn's file also in git) is shown once.
      if (keys.has(file.stat.path)) continue;
      keys.set(file.stat.path, info);
      files.push(file);
      stats.push(file.stat);
      additions += file.stat.additions ?? 0;
      deletions += file.stat.deletions ?? 0;
    }
    groups.push({ key: groupKey, label, root, stats, additions, deletions });
  };
  for (const root of roots) emit(root.path, labels.get(root.path) ?? root.name, root);
  emit(OTHER_GROUP, "Other", null);

  const grouped = groups.length > 1 || (groups.length === 1 && groups[0].root?.kind !== "main");
  return {
    files,
    stats: files.map((f) => f.stat),
    groups,
    grouped,
    keys,
    keyOf: (path) => (keys.has(path) ? path : keyFor(placeFile(path, roots), labels)),
  };
}

function rekey(file: ReviewFile, key: string, oldKey: string | undefined): ReviewFile {
  if (file.stat.path === key && file.stat.oldPath === oldKey) return file;
  const { oldPath: _old, ...rest } = file.stat;
  return {
    ...file,
    stat: { ...rest, path: key, ...(oldKey ? { oldPath: oldKey } : {}) },
    fileDiff: relabel(file.fileDiff, key, oldKey),
  };
}
