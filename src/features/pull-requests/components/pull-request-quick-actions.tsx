// Shift quick actions for a pull-request row: Close, Merge, Ready for review
// and Reopen, shown while Shift is held (and while one is running). Merge
// still takes a second click. Pressing Close and dragging down the rows
// closes them all on release (Escape cancels), and the toast after offers to
// reopen them.
//
// Whether Shift is held travels by context, not as a row prop: a Shift press
// then re-renders each row's action group and nothing else. Everything a
// group needs to act (the runner, the sweep, the host's actions) sits in a
// second, stable context, so rows never take callbacks that change.
//
// Reused by any surface that lists pull requests: wrap the list in
// `PullRequestQuickActionsProvider` and drop `PullRequestQuickActions` into
// each row.

import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/ui/button";

import { classifyPrError } from "../lib/pr-errors";
import { lastMergeMethod, removeAgentCreditsOnMerge } from "../lib/pull-request-prefs";
import {
  pullRequestQuickActions,
  resolveSweepKeys,
  type PullRequestQuickAction,
} from "../lib/pull-request-list-logic";
import {
  ACTION_FAILURE_LABELS,
  allowedMergeMethods,
  resolveMergeMethod,
} from "../lib/pull-request-logic";
import { prAction, prDetail } from "../lib/pull-requests-api";
import { pullRequestKeys } from "../lib/pull-requests-queries";
import type { PrAction, PrListEntry } from "../lib/pull-requests-types";
import { readableFailure } from "../lib/use-pull-request-actions";
import { useInlineConfirm } from "../lib/use-inline-confirm";

export type QuickActionEntry = Pick<PrListEntry, "number" | "title" | "state" | "isDraft">;

export interface QuickActionResult {
  entry: QuickActionEntry;
  action: PrAction;
}

const ACTIONS: Record<
  PullRequestQuickAction,
  { label: string; done: string; Icon: typeof GitMerge; hint: string }
> = {
  close: {
    label: "Close",
    done: "Pull request closed",
    Icon: GitPullRequestClosed,
    hint: "GitHub refused it. Check that you have write access, or that you opened it.",
  },
  merge: {
    label: "Merge",
    done: "Pull request merged",
    Icon: GitMerge,
    hint: "GitHub refused the merge. Check that you have write access, that the required checks have passed, and that the branch does not conflict.",
  },
  ready: {
    label: "Ready",
    done: "Marked ready for review",
    Icon: GitPullRequestArrow,
    hint: "GitHub refused it. Check that you have write access to this repository.",
  },
  reopen: {
    label: "Reopen",
    done: "Pull request reopened",
    Icon: GitPullRequestArrow,
    hint: "GitHub refused it. Check that you have write access, and that the branch still exists.",
  },
};

// ── Shift ───────────────────────────────────────────────────────────────

/** Whether Shift alone is held. Read with `use`, so only the groups re-render. */
export const QuickActionModeContext = createContext(false);

function useShiftHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const read = (event: KeyboardEvent | PointerEvent) =>
      setHeld(event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey);
    const release = () => setHeld(false);
    window.addEventListener("keydown", read, true);
    window.addEventListener("keyup", read, true);
    // A Shift pressed while another window had focus shows on the first move.
    window.addEventListener("pointermove", read, { capture: true, passive: true });
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", read, true);
      window.removeEventListener("keyup", read, true);
      window.removeEventListener("pointermove", read, true);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
}

// ── running them ────────────────────────────────────────────────────────

/** One quick action against `repoPath`, toasting either way. A merge reads
 *  the pull request first, for the methods this repository allows and the
 *  head it would merge, so it never merges a head nobody has seen loaded. */
async function runQuickAction(
  client: QueryClient,
  repoPath: string,
  entry: QuickActionEntry,
  action: PullRequestQuickAction,
  onActed: ((result: QuickActionResult) => void) | undefined,
): Promise<boolean> {
  try {
    if (action === "merge") {
      const detail = await client.fetchQuery({
        queryKey: pullRequestKeys.detail(repoPath, entry.number),
        queryFn: () => prDetail(repoPath, entry.number),
        staleTime: 0,
      });
      if (!detail.viewerPermissions.actions.includes("merge")) {
        throw { kind: "failed", message: "This pull request cannot be merged right now." };
      }
      const allowed = allowedMergeMethods(detail);
      if (allowed.length === 0) {
        throw { kind: "failed", message: "No merge method is allowed in this repository." };
      }
      await prAction(repoPath, entry.number, {
        action,
        mergeMethod: resolveMergeMethod(allowed, null, lastMergeMethod()),
        expectedHeadOid: detail.headSha,
        removeAgentCredits: removeAgentCreditsOnMerge(repoPath),
      });
    } else {
      await prAction(repoPath, entry.number, { action });
    }
    toast.success(`${ACTIONS[action].done}`, {
      description: `#${entry.number} ${entry.title}`,
    });
    onActed?.({ entry, action });
    return true;
  } catch (raw) {
    toast.error(ACTION_FAILURE_LABELS[action], {
      description: readableFailure(classifyPrError(raw), ACTIONS[action].hint),
    });
    return false;
  } finally {
    void client.invalidateQueries({ queryKey: pullRequestKeys.pull(repoPath, entry.number) });
    void client.invalidateQueries({ queryKey: ["pull-requests", repoPath, "list"] });
  }
}

export function useQuickActionRunner(
  repoPath: string,
  onActed?: (result: QuickActionResult) => void,
) {
  const client = useQueryClient();
  const acted = useRef(onActed);
  acted.current = onActed;
  return useCallback(
    (entry: QuickActionEntry, action: PullRequestQuickAction): Promise<boolean> =>
      runQuickAction(client, repoPath, entry, action, acted.current),
    [client, repoPath],
  );
}

/** The runner for a list whose rows live in different checkouts (a
 *  session's linked pull requests): the checkout comes with each call. */
export function useQuickActionRunnerAnywhere(onActed?: (result: QuickActionResult) => void) {
  const client = useQueryClient();
  const acted = useRef(onActed);
  acted.current = onActed;
  return useCallback(
    (repoPath: string, entry: QuickActionEntry, action: PullRequestQuickAction): Promise<boolean> =>
      runQuickAction(client, repoPath, entry, action, acted.current),
    [client],
  );
}

/** At most this many closes in flight at once, so a long sweep does not
 *  spawn a `gh` per row in one go. */
const CLOSE_CONCURRENCY = 4;

async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  });
  await Promise.all(workers);
}

/** Close several at once (the sweep), with one toast for all of them and a
 *  Reopen in it that puts back the ones that closed. */
export function useCloseBatch(repoPath: string, onActed?: (result: QuickActionResult) => void) {
  const client = useQueryClient();
  const pending = useRef(new Set<number>());
  const [closing, setClosing] = useState<ReadonlySet<number>>(() => new Set());
  const acted = useRef(onActed);
  acted.current = onActed;

  const runAll = useCallback(
    async (entries: readonly QuickActionEntry[], action: "close" | "reopen") => {
      const done: QuickActionEntry[] = [];
      const failures: string[] = [];
      await eachLimited(entries, CLOSE_CONCURRENCY, async (entry) => {
        try {
          await prAction(repoPath, entry.number, { action });
          done.push(entry);
          acted.current?.({ entry, action });
        } catch (raw) {
          failures.push(
            `#${entry.number}: ${readableFailure(classifyPrError(raw), ACTIONS[action].hint)}`,
          );
        } finally {
          pending.current.delete(entry.number);
          setClosing(new Set(pending.current));
        }
      });
      void client.invalidateQueries({ queryKey: ["pull-requests", repoPath, "list"] });
      return { done, failures };
    },
    [client, repoPath],
  );

  const close = useCallback(
    async (entries: readonly QuickActionEntry[]) => {
      const batch = entries.filter((entry) => {
        if (entry.state !== "open" || pending.current.has(entry.number)) return false;
        pending.current.add(entry.number);
        return true;
      });
      if (batch.length === 0) return;
      setClosing(new Set(pending.current));
      const { done, failures } = await runAll(batch, "close");
      const noun = (n: number) => `pull request${n === 1 ? "" : "s"}`;
      const reopen =
        done.length > 0
          ? {
              label: "Reopen",
              onClick: () => {
                void runAll(done, "reopen").then((back) => {
                  if (back.failures.length > 0) {
                    toast.error(`Reopened ${back.done.length} of ${done.length}`, {
                      description: back.failures.slice(0, 3).join("\n"),
                    });
                  } else {
                    toast.success(`Reopened ${back.done.length} ${noun(back.done.length)}`);
                  }
                });
              },
            }
          : undefined;
      if (failures.length > 0) {
        toast.error(`Closed ${done.length} of ${batch.length} ${noun(batch.length)}`, {
          description: failures.slice(0, 3).join("\n"),
          action: reopen,
        });
      } else {
        toast.success(`Closed ${done.length} ${noun(done.length)}`, { action: reopen });
      }
    },
    [runAll],
  );

  return { close, closing };
}

// ── the sweep ───────────────────────────────────────────────────────────

/** Pixels the pointer travels before a press on Close becomes a sweep. */
export const SWEEP_DISTANCE = 6;
const SWEEP_EDGE = 28;
const SWEEP_SCROLL_STEP = 12;

/** The row under `y`: the last whose top is at or above it, clamped to the
 *  rows there are. Pure, for the test. */
export function sweepRowAtY<Key>(
  rows: readonly { key: Key; top: number }[],
  y: number,
): Key | null {
  let key: Key | null = null;
  for (const row of rows) {
    if (key !== null && row.top > y) break;
    key = row.key;
  }
  return key;
}

export interface CloseSweepOptions<Row extends QuickActionEntry> {
  /** The scrolling element whose rows carry `data-pull-request-number`. */
  scrollerRef: RefObject<HTMLElement | null>;
  /** Read at every step: the rows in screen order, and whether one can be
   *  swept from `origin`. */
  read: () => { ordered: readonly number[]; rows: ReadonlyMap<number, Row> };
  canSweep: (origin: Row, row: Row) => boolean;
  onCommit: (rows: Row[]) => void;
}

/**
 * Press on Close, drag across rows, release to close them all; Escape, or a
 * new list under the sweep, cancels. A press that never travels is a plain
 * click and is left to the button.
 */
export function useCloseSweep<Row extends QuickActionEntry>(options: CloseSweepOptions<Row>) {
  const latest = useRef(options);
  latest.current = options;
  const [swept, setSwept] = useState<ReadonlySet<number>>(() => new Set());
  const active = useRef<(() => void) | null>(null);
  const endedAt = useRef(0);

  useEffect(() => () => active.current?.(), []);

  const start = useCallback((origin: Row, event: PointerEvent) => {
    active.current?.();
    const startY = event.clientY;
    let sweeping = false;
    let keys: number[] = [];
    let target: number | null = null;
    const can = (number: number) => {
      const row = latest.current.read().rows.get(number);
      return row !== undefined && latest.current.canSweep(origin, row);
    };
    const sweepTo = (number: number) => {
      if (number === target) return;
      target = number;
      keys = resolveSweepKeys(latest.current.read().ordered, origin.number, number, can);
      setSwept(new Set(keys));
    };
    const rowAt = (y: number) => {
      const scroller = latest.current.scrollerRef.current;
      if (!scroller) return null;
      const bounds = scroller.getBoundingClientRect();
      const clamped = Math.min(Math.max(y, bounds.top), bounds.bottom - 1);
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-pull-request-number]")]
        .map((node) => ({
          key: Number(node.dataset.pullRequestNumber),
          top: node.getBoundingClientRect().top,
        }))
        .sort((a, b) => a.top - b.top);
      return sweepRowAtY(rows, clamped);
    };
    const finish = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", onKey, true);
      if (active.current === finish) active.current = null;
      if (sweeping) endedAt.current = performance.now();
      setSwept(new Set());
    };
    const cancel = () => finish();
    const onMove = (move: PointerEvent) => {
      if (!sweeping) {
        if (Math.abs(move.clientY - startY) < SWEEP_DISTANCE) return;
        sweeping = true;
        sweepTo(origin.number);
      }
      const scroller = latest.current.scrollerRef.current;
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        if (move.clientY > bounds.bottom - SWEEP_EDGE) scroller.scrollTop += SWEEP_SCROLL_STEP;
        else if (move.clientY < bounds.top + SWEEP_EDGE) scroller.scrollTop -= SWEEP_SCROLL_STEP;
      }
      const number = rowAt(move.clientY);
      if (number !== null) sweepTo(number);
    };
    const onUp = () => {
      const commit = sweeping ? keys.filter(can) : [];
      finish();
      if (commit.length === 0) return;
      const rows = latest.current.read().rows;
      latest.current.onCommit(commit.flatMap((number) => rows.get(number) ?? []));
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      finish();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", onKey, true);
    active.current = finish;
  }, []);

  const cancel = useCallback(() => active.current?.(), []);
  /** True for the click that a sweep's release lands as, which must not
   *  close the origin a second time. */
  const justSwept = useCallback(() => performance.now() - endedAt.current < 250, []);

  return { swept, start, cancel, justSwept };
}

// ── the provider and the group ──────────────────────────────────────────

interface QuickActionHandlers {
  hostActions: ReadonlySet<PrAction>;
  perform: (entry: QuickActionEntry, action: PullRequestQuickAction) => Promise<boolean>;
  startSweep?: (entry: QuickActionEntry, event: PointerEvent) => void;
  justSwept?: () => boolean;
}

const QuickActionHandlersContext = createContext<QuickActionHandlers | null>(null);

export function PullRequestQuickActionsProvider({
  hostActions,
  perform,
  startSweep,
  justSwept,
  children,
}: QuickActionHandlers & { children: ReactNode }) {
  const shift = useShiftHeld();
  const handlers = useMemo(
    () => ({ hostActions, perform, startSweep, justSwept }),
    [hostActions, perform, startSweep, justSwept],
  );
  return (
    <QuickActionHandlersContext value={handlers}>
      <QuickActionModeContext value={shift}>{children}</QuickActionModeContext>
    </QuickActionHandlersContext>
  );
}

function PullRequestQuickActionsImpl({
  entry,
  pending = false,
  sweeping = false,
}: {
  entry: QuickActionEntry;
  /** Closing as part of a sweep. */
  pending?: boolean;
  /** Under a sweep being dragged. */
  sweeping?: boolean;
}) {
  const shift = use(QuickActionModeContext);
  const handlers = use(QuickActionHandlersContext);
  const [running, setRunning] = useState<PullRequestQuickAction | null>(null);
  const confirm = useInlineConfirm(`pull-request-quick:${entry.number}`);
  if (!handlers) return null;
  const actions = pullRequestQuickActions(entry, handlers.hostActions);
  if (actions.length === 0) return null;
  const busy = running !== null || pending;
  const shown = shift || busy || sweeping || confirm.isArmed("merge");
  const run = (action: PullRequestQuickAction) => {
    if (busy) return;
    setRunning(action);
    void handlers.perform(entry, action).finally(() => setRunning(null));
  };
  return (
    <div
      role="group"
      aria-label={`Quick actions for pull request #${entry.number}`}
      data-quick-action-pending={busy}
      className="items-center gap-1"
      style={{ display: shown ? "flex" : "none" }}
    >
      {actions.map((action) => {
        const { label, Icon } = ACTIONS[action];
        const armed = action === "merge" && confirm.isArmed("merge");
        const spinning = running === action || (pending && action === "close");
        const title =
          action === "merge"
            ? armed
              ? "Click again to merge"
              : "Merge (asks again)"
            : action === "close" && handlers.startSweep
              ? "Close, or drag down the rows to close several"
              : `${label} now`;
        const confirmProps = action === "merge" ? confirm.props("merge", () => run("merge")) : null;
        return (
          <Button
            key={action}
            variant={armed ? "default" : "outline"}
            size="xs"
            disabled={busy}
            title={title}
            aria-label={`${armed ? "Confirm merge" : label} #${entry.number}`}
            onKeyDown={confirmProps?.onKeyDown}
            onClick={(event) => {
              event.stopPropagation();
              if (confirmProps) return confirmProps.onClick(event);
              if (action === "close" && handlers.justSwept?.()) return;
              run(action);
            }}
            onPointerDown={(event) => {
              if (action !== "close" || !handlers.startSweep) return;
              if (!event.isPrimary || event.button !== 0) return;
              handlers.startSweep(entry, event.nativeEvent);
            }}
          >
            {spinning ? (
              <LoaderCircle aria-hidden className="size-3 animate-spin" />
            ) : (
              <Icon aria-hidden className={action === "close" ? "size-3 text-error" : "size-3"} />
            )}
            {armed ? "Confirm merge" : label}
          </Button>
        );
      })}
    </div>
  );
}

export const PullRequestQuickActions = memo(PullRequestQuickActionsImpl);
