import type { FileContents, ThemedFileResult } from "@pierre/diffs";
import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { DIFF_THEME_NAMES, ensureDiffTheme } from "../../lib/diff-theme";
import { colourFirstScreen } from "../../lib/first-screen-highlight";

/**
 * The Shiki workers every diff viewer tokenizes in. A viewer renders nothing
 * until its pool is up, rather than fall back to highlighting in the UI's own
 * frame budget. The one main-thread exception is bounded: the first few hundred
 * lines of a long file, so its first screen isn't plain while the workers
 * tokenize the rest (`FirstScreenWorkerPool`).
 *
 * One pool for the window, shared by every mounted viewer and kept for a while
 * after the last one goes, so closing and reopening the diff does not pay for
 * new workers and a cold grammar cache.
 */

/** Oniguruma in WASM. Shiki's JS regex engine can backtrack catastrophically
 *  on a hostile line and wedge a worker; the WASM engine cannot. */
export const PREFERRED_HIGHLIGHTER = "shiki-wasm" as const;

const IDLE_TTL_MS = 30_000;

/** Half the cores, 2–6: enough to tokenize a long diff in parallel without
 *  starving the agent's own work or the UI. */
function poolSize(): number {
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}

interface SharedPool {
  readonly pool: WorkerPoolManager;
  consumers: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/** The pool, with a long file's first screen coloured here instead of plain
 *  while the workers tokenize the rest (`first-screen-highlight.ts`). */
class FirstScreenWorkerPool extends WorkerPoolManager {
  override getPlainFileAST(
    file: FileContents,
    startingLine: number,
    totalLines: number,
    lines?: string[],
  ): ThemedFileResult | undefined {
    const plain = super.getPlainFileAST(file, startingLine, totalLines, lines);
    if (!plain) return plain;
    return (
      colourFirstScreen(
        file,
        plain,
        startingLine,
        totalLines,
        lines,
        this.getFileRenderOptions(),
      ) ?? plain
    );
  }
}

let shared: SharedPool | undefined;

function acquire(): SharedPool {
  if (!shared) {
    ensureDiffTheme();
    shared = {
      pool: new FirstScreenWorkerPool(
        {
          workerFactory: () => new DiffsWorker(),
          poolSize: poolSize(),
          totalASTLRUCacheSize: 240,
        },
        {
          // A pair of theme-variable themes (`diff-theme.ts`): a theme
          // switch recolours the cached tokens, so the pool never re-themes.
          theme: DIFF_THEME_NAMES,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          // A minified bundle's one 400 KB line would hold a worker for
          // seconds; past this length a line is shown plain.
          tokenizeMaxLineLength: 1_000,
          useTokenTransformer: true,
          // `lineDiffType` is deliberately left at the pool's `word-alt`: the
          // workers produce the highlighted AST, word-level change spans
          // included, off the main thread. The viewers' own
          // `lineDiffType: "none"` only governs the plain first paint on the
          // main thread, which therefore never pays for a word diff.
        },
      ),
      consumers: 0,
      idleTimer: undefined,
    };
  }
  const entry = shared;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  return entry;
}

function release(entry: SharedPool): void {
  entry.consumers -= 1;
  if (entry.consumers !== 0) return;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    entry.pool.terminate();
    if (shared === entry) shared = undefined;
  }, IDLE_TTL_MS);
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const entry = acquire();
  onStoreChange();
  return () => release(entry);
}

const getPool = () => shared?.pool;
const getServerPool = () => undefined;

const PoolFailedContext = createContext(false);

/** The workers could not start. A viewer then shows its diffs as plain text:
 *  highlighting them here instead would put every grammar on the UI thread. */
export function useDiffPoolFailed(): boolean {
  return useContext(PoolFailedContext);
}

let warned = false;

/** Children mount once the workers are up, so a first paint is never
 *  highlighted on the main thread. */
function PoolReady({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const pool = useWorkerPool();
  const [settled, setSettled] = useState<{ pool: WorkerPoolManager; failed: boolean }>();
  const failed = pool ? (settled?.pool === pool && settled.failed) || !pool.isWorkingPool() : false;
  const ready = pool ? settled?.pool === pool || pool.isInitialized() || failed : false;

  useEffect(() => {
    if (ready || !pool) return;
    let mounted = true;
    pool.initialize().then(
      () => {
        if (mounted) setSettled({ pool, failed: false });
      },
      (error: unknown) => {
        if (!warned) {
          warned = true;
          console.warn("Diff highlighting workers failed to start; showing plain text.", error);
        }
        // The pool is dropped at its idle timeout, so a later viewer tries
        // afresh.
        if (mounted) setSettled({ pool, failed: true });
      },
    );
    return () => {
      mounted = false;
    };
  }, [ready, pool]);

  if (!ready) return fallback;
  return <PoolFailedContext value={failed}>{children}</PoolFailedContext>;
}

export function DiffWorkerPoolProvider({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  // Stable identity: a new one would make React release and re-acquire the
  // shared pool on every render.
  const stableSubscribe = useCallback(subscribe, []);
  const pool = useSyncExternalStore(stableSubscribe, getPool, getServerPool);
  return (
    <WorkerPoolContext value={pool}>
      <PoolReady fallback={fallback}>{children}</PoolReady>
    </WorkerPoolContext>
  );
}
