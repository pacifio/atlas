import { useEffect, useMemo, useRef, useState } from "react";

import { useAgentMetaResolver } from "@/features/agents/lib/agent-meta-context";

import type { TraceSession } from "../components/checkpoint-trace";
import { projectFilterKey, type ProjectFilter, type TraceSessionRow } from "../types";
import type { AuthorDirectory } from "./author-directory";
import { agentLabel } from "./board";
import { buildTrace } from "./trace";
import { readTrace, type TraceRange, type TraceRead } from "./trace-api";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const NO_ROWS: TraceSessionRow[] = [];

/** How soon a board refresh may re-read the same window. The server half is a
 *  network walk, and the board refreshes on every capture and git event. */
const REFRESH_FLOOR_MS = 30_000;

/** The last seven days, ending now. */
export function lastWeek(now = Date.now()): TraceRange {
  return { from: new Date(now - WEEK_MS).toISOString(), to: new Date(now).toISOString() };
}

interface Held extends TraceRead {
  /** The scope this read answered — see `scopeKey`. */
  key: string;
}

/**
 * The Trace view's rows: every Session active in the window, each with its
 * Checkpoints, as the `CheckpointTrace` block's props.
 *
 * Scope is the board's. With a Project chosen in its Project pill the read
 * names that Workspace; with "All" it is the Organisation's. The Agent and
 * People pills narrow what is drawn, as they narrow the board.
 *
 * Read again when the scope or the window changes, and when the board
 * refreshes — at most every {@link REFRESH_FLOOR_MS}, with a trailing read so
 * the last change is never dropped. With no window chosen the window is the
 * last week **as of each read**, so a live Session's new Checkpoints land on
 * the chart rather than past the end of a window frozen at mount.
 */
export function useTraceData({
  refresh,
  projectPaths,
  projectsKey,
  projectFilter,
  directory,
  rangeChoice,
  agent,
  people,
}: {
  /** The board's read: a new identity means the board re-read and found
   *  something. */
  refresh: unknown;
  projectPaths: string[];
  /** Stable stand-in for `projectPaths`, as the board uses. */
  projectsKey: string;
  projectFilter: ProjectFilter | null;
  directory: AuthorDirectory;
  /** A window the user moved to, or `null` to follow the last week. */
  rangeChoice: TraceRange | null;
  agent: string | null;
  people: (string | null)[];
}): {
  sessions: TraceSession[];
  /** The read as it arrived, every page, for the opener. */
  rows: TraceSessionRow[];
  /** The window on screen. */
  range: TraceRange;
  loading: boolean;
  notes: string[];
  error: string | null;
} {
  /** What the read depends on. A read for another scope or window is not
   *  shown under this one while the new read is in flight. */
  const scopeKey = [
    projectsKey,
    projectFilter ? projectFilterKey(projectFilter) : "",
    rangeChoice ? `${rangeChoice.from}~${rangeChoice.to}` : "follow",
  ].join("\n");
  const [held, setHeld] = useState<Held>(() => ({
    key: "",
    range: rangeChoice ?? lastWeek(),
    sessions: [],
    notes: [],
    projectNames: new Map(),
  }));
  const [error, setError] = useState<string | null>(null);
  /** Only the newest read may write state — `invoke` has no abort. */
  const seq = useRef(0);
  /** When the current scope was last read, for the refresh floor. */
  const lastRead = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  /** Read through a ref so the effect keys on `projectsKey` — same content,
   *  stable identity — rather than on a fresh array. */
  const paths = useRef(projectPaths);
  paths.current = projectPaths;

  // `refresh` is not read here: its identity is the board's "something
  // changed" signal, which is why it is a dependency.
  useEffect(() => {
    const key = scopeKey;
    const read = () => {
      const mine = ++seq.current;
      lastRead.current = { key, at: Date.now() };
      readTrace(paths.current, projectFilter, rangeChoice ?? lastWeek())
        .then((answer) => {
          if (mine !== seq.current) return;
          setHeld({ key, ...answer });
          setError(null);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          setError(String(e));
          // A refresh of the same scope that failed keeps what is on screen —
          // it is still this window, just possibly behind. A new scope or
          // window keeps nothing from the old one.
          setHeld((prev) =>
            prev.key === key
              ? prev
              : {
                  key,
                  range: rangeChoice ?? lastWeek(),
                  sessions: [],
                  notes: [],
                  projectNames: new Map(),
                },
          );
        });
    };
    const since = Date.now() - lastRead.current.at;
    if (lastRead.current.key !== key || since >= REFRESH_FLOOR_MS) {
      read();
      return;
    }
    const timer = setTimeout(read, REFRESH_FLOOR_MS - since);
    return () => clearTimeout(timer);
  }, [scopeKey, projectFilter, rangeChoice, refresh]);

  const current = held.key === scopeKey;
  const resolveAgent = useAgentMetaResolver();
  const sessions = useMemo(
    () =>
      current
        ? buildTrace({
            rows: held.sessions,
            directory,
            range: held.range,
            agentLabelOf: (id) => agentLabel(id, resolveAgent),
            projectNames: held.projectNames,
            agent,
            people,
          })
        : [],
    [current, held, directory, resolveAgent, agent, people],
  );

  return {
    sessions,
    rows: current ? held.sessions : NO_ROWS,
    range: held.range,
    loading: !current,
    notes: current ? held.notes : [],
    error: current ? error : null,
  };
}
