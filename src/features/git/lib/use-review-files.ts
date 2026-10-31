import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { FileDiffMetadata } from "@pierre/diffs";
import { getDiffFilePatch, type DiffFileStat, type DiffSource } from "./git-review-api";
import { getRenderablePatch, resolveFileDiffPath } from "./diff-rendering";

/**
 * One changed file of a review source, in the order the panel lists it, with
 * whatever of it has arrived.
 *
 * The source's patch is capped near 120 KB at a file boundary, so on a large
 * change only a prefix of the files is in it. Those render from the patch at
 * once. Each one past the cap is diffed by git on its own
 * (`getDiffFilePatch`): a few up front, then each as its row scrolls into the
 * viewer's render window (`requestFile`), or when the reader picks it in the
 * tree. This thread only parses the patch that comes back.
 */
export interface ReviewFile {
  stat: DiffFileStat;
  /** The file's diff; an empty, partial stand-in until it is `ready`. */
  fileDiff: FileDiffMetadata;
  /** `too-large`: over the per-file cap with not even one whole hunk.
   *  `empty`: listed, but git now finds no change (it settled meanwhile). */
  state: "ready" | "pending" | "error" | "binary" | "too-large" | "empty";
  /** Over the per-file cap: only the first hunks are shown. */
  truncated: boolean;
  /** A turn's file known only by the fragments its edits replaced: the diff
   *  is an excerpt of the file, not the file. Turn scope only. */
  excerpt?: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** How many missing files load before any row asks. */
const INITIAL_BATCH = 4;
/** Lazily loaded patches kept for files no viewer shows any more. */
const MAX_IDLE_ENTRIES = 48;
/** Files kept requested (observed) at once: the render window and the tree's
 *  picks, with room to spare. Past it the least recently asked one goes idle. */
export const MAX_WATCHED = 64;
const QUERY_ROOT = "git-diff-file";

interface Loaded {
  fileDiff: FileDiffMetadata | null;
  state: "ready" | "binary" | "too-large" | "empty";
  truncated: boolean;
}

const isNewStatus = (s: DiffFileStat["status"]) => s === "added" || s === "untracked";

/** What a file shows before (or instead of) its diff: its header and nothing
 *  under it. */
function placeholderOf(stat: DiffFileStat): FileDiffMetadata {
  return {
    name: stat.path,
    ...(stat.oldPath ? { prevName: stat.oldPath } : {}),
    type: isNewStatus(stat.status)
      ? "new"
      : stat.status === "deleted"
        ? "deleted"
        : stat.oldPath
          ? "rename-changed"
          : "change",
    hunks: [],
    additionLines: [],
    deletionLines: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
  };
}

/** Drop the oldest lazily loaded patches no viewer holds, past a cap: each can
 *  be up to a megabyte, and a long-running review touches many. */
function pruneIdle(client: QueryClient, repoPath: string) {
  const idle = client
    .getQueryCache()
    .findAll({ queryKey: [QUERY_ROOT, repoPath] })
    .filter((q) => q.getObserversCount() === 0)
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
  for (const q of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_ENTRIES))) {
    client.getQueryCache().remove(q);
  }
}

/** The newest loaded patch under a key prefix, if any is still cached. */
function latestCached(client: QueryClient, queryKey: readonly unknown[]): Loaded | undefined {
  let best: { at: number; data: Loaded } | undefined;
  for (const q of client.getQueryCache().findAll({ queryKey })) {
    const data = q.state.data as Loaded | undefined;
    if (data && (!best || q.state.dataUpdatedAt > best.at)) {
      best = { at: q.state.dataUpdatedAt, data };
    }
  }
  return best?.data;
}

export function useReviewFiles({
  repoPath,
  source,
  ignoreWhitespace,
}: {
  repoPath: string;
  source: DiffSource | null;
  ignoreWhitespace: boolean;
}) {
  const kind = source?.kind;
  const base = source?.mergeBase ?? source?.baseRef ?? null;
  /** What the files are a diff OF. A refresh within it (an edit) keeps it;
   *  only a change of source, base or whitespace mode starts afresh. */
  const scope = source ? `${repoPath}\0${kind}\0${base ?? ""}\0${ignoreWhitespace}` : "";
  const cacheScope = `review:${kind ?? ""}`;

  // Parsed once per patch. A file whose content is unchanged keeps its old
  // object, so the viewer and every memo below see nothing new for it.
  const previousParse = useRef(new Map<string, FileDiffMetadata>());
  const fromPatch = useMemo(() => {
    const map = new Map<string, FileDiffMetadata>();
    const patch = getRenderablePatch(source?.diff, cacheScope);
    if (patch?.kind === "files") {
      for (const f of patch.files) {
        const path = resolveFileDiffPath(f);
        const prior = previousParse.current.get(path);
        map.set(path, prior && prior.cacheKey === f.cacheKey ? prior : f);
      }
    }
    previousParse.current = map;
    return map;
  }, [source?.diff, cacheScope]);

  const stats = useMemo(() => {
    const files = [...(source?.files ?? [])];
    return files.sort((a, b) => collator.compare(a.path, b.path));
  }, [source?.files]);

  // One stand-in object per file, so an unchanged row keeps its identity.
  const placeholders = useMemo(
    () => new Map(stats.map((stat) => [stat.path, placeholderOf(stat)])),
    [stats],
  );

  /** Files not in the patch, in list order: the ones to fetch. */
  const missing = useMemo(
    () => stats.filter((f) => !f.binary && !fromPatch.has(f.path)).map((f) => f.path),
    [stats, fromPatch],
  );

  // The files rows have asked for, least recently asked first, at most
  // `MAX_WATCHED`: each is an observed query, which `pruneIdle` never
  // drops, so an unbounded list would hold every patch a long review saw.
  const [requested, setRequested] = useState<{ scope: string; paths: readonly string[] }>({
    scope: "",
    paths: [],
  });
  const wanted = useMemo(() => {
    const paths = new Set(requested.scope === scope ? requested.paths : []);
    for (const path of missing.slice(0, INITIAL_BATCH)) paths.add(path);
    const stillMissing = new Set(missing);
    return [...paths].filter((p) => stillMissing.has(p));
  }, [requested, scope, missing]);

  const statByPath = useMemo(() => new Map(stats.map((s) => [s.path, s])), [stats]);

  const results = useQueries({
    queries: wanted.map((path) => {
      const stat = statByPath.get(path);
      return {
        // Keyed by what makes this file's patch what it is: the file on disk
        // (`sig`: mtime and size), its counts and status, and the base it is
        // diffed against. A write to it is a new key; an edit elsewhere is
        // not, and serves this one from cache. A commit moves HEAD without
        // touching the file, so the panel invalidates on `atlas:git-changed`.
        queryKey: [
          QUERY_ROOT,
          repoPath,
          kind,
          base,
          ignoreWhitespace,
          path,
          stat?.oldPath ?? null,
          stat?.sig ?? null,
          stat?.additions ?? null,
          stat?.deletions ?? null,
          stat?.status ?? null,
        ],
        enabled: !!source && !!stat,
        staleTime: Infinity,
        gcTime: 60_000,
        queryFn: async (): Promise<Loaded> => {
          const res = await getDiffFilePatch(repoPath, {
            sourceKind: kind!,
            baseRef: base,
            filePath: path,
            oldPath: stat?.oldPath ?? null,
            ignoreWhitespace,
          });
          if (res.binary) return { fileDiff: null, state: "binary", truncated: false };
          if (!res.patch) {
            return {
              fileDiff: null,
              state: res.truncated ? "too-large" : "empty",
              truncated: false,
            };
          }
          const parsed = getRenderablePatch(res.patch, cacheScope);
          if (parsed?.kind !== "files") throw new Error(parsed?.reason ?? "Empty patch.");
          return { fileDiff: parsed.files[0], state: "ready", truncated: res.truncated };
        },
      };
    }),
  });

  const queryClient = useQueryClient();
  useEffect(() => pruneIdle(queryClient, repoPath), [queryClient, repoPath, wanted]);

  // `results` is a new array every render; this changes only when one of
  // them does, which is what `files` (and everything keyed on it) follows.
  const resultsKey = results
    .map((r) => `${r.status}:${r.dataUpdatedAt}:${r.errorUpdatedAt}`)
    .join("|");

  const files = useMemo<ReviewFile[]>(() => {
    const byPath = new Map<string, (typeof results)[number]>();
    wanted.forEach((path, i) => byPath.set(path, results[i]));
    return stats.map((stat): ReviewFile => {
      const stand = placeholders.get(stat.path)!;
      if (stat.binary) return { stat, fileDiff: stand, state: "binary", truncated: false };
      const parsed = fromPatch.get(stat.path);
      if (parsed) return { stat, fileDiff: parsed, state: "ready", truncated: false };
      const result = byPath.get(stat.path);
      let data = result?.data;
      // While a file's new key loads after a write, its row keeps the diff
      // its previous key holds (still cached, idle) instead of folding to a
      // placeholder and back. The key prefix is the scope.
      if (!data && result && !result.isError) {
        data = latestCached(queryClient, [
          QUERY_ROOT,
          repoPath,
          kind,
          base,
          ignoreWhitespace,
          stat.path,
        ]);
      }
      if (!data) {
        const state = result?.isError ? "error" : "pending";
        return { stat, fileDiff: stand, state, truncated: false };
      }
      return {
        stat,
        fileDiff: data.fileDiff ?? stand,
        state: data.state,
        truncated: data.truncated,
      };
    });
    // `resultsKey` stands for `results`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stats,
    placeholders,
    fromPatch,
    wanted,
    resultsKey,
    queryClient,
    repoPath,
    kind,
    base,
    ignoreWhitespace,
  ]);

  // Stable per scope: every pending row's header holds it.
  const requestFile = useCallback(
    (path: string) =>
      setRequested((current) => {
        const prior = current.scope === scope ? current.paths : [];
        if (prior[prior.length - 1] === path) return current;
        const paths = prior.filter((p) => p !== path);
        paths.push(path);
        return { scope, paths: paths.slice(-MAX_WATCHED) };
      }),
    [scope],
  );

  const resultsRef = useRef({ wanted, results });
  resultsRef.current = { wanted, results };
  const retry = useCallback((path: string) => {
    const { wanted: w, results: r } = resultsRef.current;
    const i = w.indexOf(path);
    if (i >= 0) void r[i]?.refetch();
  }, []);

  return {
    /** Stable across refreshes of the same source; see above. */
    scope,
    files,
    /** Each file's stat, in list order; changes only with the file list. */
    stats: stats as readonly DiffFileStat[],
    isFetching: results.some((r) => r.isFetching),
    /** Fetch one file now: its row came into view, or the tree asked. */
    requestFile,
    retry,
  };
}

/** Every lazily loaded patch under `repoPath`: a commit or checkout moved
 *  HEAD under them without touching the files their keys follow. */
export function invalidateReviewFiles(client: QueryClient, repoPath: string) {
  void client.invalidateQueries({ queryKey: [QUERY_ROOT, repoPath] });
}
