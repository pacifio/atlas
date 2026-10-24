// The list's change breakdowns, read for the rows on screen: the numbers
// the virtualizer shows are batched into one `pr_list_stats` read once the
// scroll settles, and each answer is kept for the tab's life (until a
// refresh drops them). Rows nobody scrolls to cost nothing.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  toChangeBreakdown,
  type PullRequestChangeBreakdown,
} from "./pull-request-change-breakdown";
import { pullRequestStatsToRequest } from "./pull-request-list-logic";
import { prListStats } from "./pull-requests-api";

/** How long the rows on screen must hold still before they are read. */
export const STATS_SETTLE_MS = 150;

export type PullRequestBreakdowns = ReadonlyMap<number, PullRequestChangeBreakdown | null>;

export function usePullRequestListStats(
  repoPath: string,
  visible: readonly number[],
  enabled: boolean,
): { breakdowns: PullRequestBreakdowns; reset: () => void } {
  const [breakdowns, setBreakdowns] = useState<PullRequestBreakdowns>(() => new Map());
  const inFlight = useRef(new Set<number>());
  const unanswered = useRef(new Set<number>());
  const held = useRef(breakdowns);
  held.current = breakdowns;
  // Answers from before a reset or another checkout are dropped.
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current += 1;
    inFlight.current = new Set();
    unanswered.current = new Set();
    setBreakdowns(new Map());
  }, []);

  const shownFor = useRef(repoPath);
  useEffect(() => {
    if (shownFor.current === repoPath) return;
    shownFor.current = repoPath;
    reset();
  }, [repoPath, reset]);

  const visibleKey = visible.join(",");
  useEffect(() => {
    if (!enabled || visibleKey === "") return;
    const timer = window.setTimeout(() => {
      const numbers = pullRequestStatsToRequest(
        visibleKey.split(",").map(Number),
        new Set([...held.current.keys(), ...unanswered.current]),
        inFlight.current,
      );
      if (numbers.length === 0) return;
      const asked = generation.current;
      for (const number of numbers) inFlight.current.add(number);
      void prListStats(repoPath, numbers)
        .then((stats) => {
          if (asked !== generation.current) return;
          // A number the host did not answer for is not asked about again.
          const answered = new Set(stats.map((stat) => stat.number));
          for (const number of numbers) if (!answered.has(number)) unanswered.current.add(number);
          setBreakdowns((current) => {
            const next = new Map(current);
            for (const stat of stats) next.set(stat.number, toChangeBreakdown(stat));
            return next;
          });
        })
        .catch(() => {
          // The counts still show from the listing; only the hover's split
          // is missing, and the next scroll asks again.
        })
        .finally(() => {
          if (asked !== generation.current) return;
          for (const number of numbers) inFlight.current.delete(number);
        });
    }, STATS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, repoPath, visibleKey]);

  return { breakdowns, reset };
}
