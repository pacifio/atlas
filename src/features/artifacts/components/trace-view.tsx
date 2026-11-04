/**
 * The Timeline's Trace view: Sessions on a time axis, each one's Checkpoints
 * where they landed, with the face of whoever drove it.
 *
 * The container only. It owns the window, the zoom and the grouping, reads the
 * data, and answers the chart's callbacks with the Timeline's own opener; the
 * chart is `CheckpointTrace`, drawn by `@tryatlas/design` (see
 * `checkpoint-trace.tsx`).
 *
 * Scope is the board's: with a Project chosen in the Project pill it is that
 * project's trace, with "All" it is the Organisation's.
 */

import { Segmented } from "@tryatlas/design";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { AccountAvatarView } from "@/features/auth/components/views/account-avatar-view";
import { DestinationActions } from "@/features/layout/components/destination-actions";

import type { OpenSession } from "../stores/artifacts-store";
import { avatarOf, type AuthorDirectory } from "../lib/author-directory";
import { foldTraceRows } from "../lib/trace";
import type { TraceRange } from "../lib/trace-api";
import { useTraceData } from "../lib/use-trace-data";
import type { BoardSession, ProjectFilter } from "../types";
import { AgentGlyph } from "./agent-glyph";
import {
  CheckpointTrace,
  type TraceAuthor,
  type TraceCheckpoint,
  type TraceGroupBy,
  type TraceSession,
  type TraceZoom,
} from "./checkpoint-trace";

const GROUPINGS: { value: TraceGroupBy; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "person", label: "Person" },
  { value: "none", label: "None" },
];

export function TraceView({
  boardSessions,
  directory,
  projectPaths,
  projectsKey,
  projectFilter,
  agent,
  people,
  onOpen,
  filters,
}: {
  /** The board's whole read: the signal that it refreshed, and where a
   *  Session's checkout is found when the trace row does not name one. */
  boardSessions: BoardSession[];
  directory: AuthorDirectory;
  projectPaths: string[];
  projectsKey: string;
  projectFilter: ProjectFilter | null;
  /** The board's Agent and People pills. */
  agent: string | null;
  people: (string | null)[];
  onOpen: (open: OpenSession) => void;
  /** The view toggle and the pills, in the destination bar. */
  filters?: ReactNode;
}) {
  /** `null` follows the last week as of each read; a moved window stays put. */
  const [rangeChoice, setRange] = useState<TraceRange | null>(null);
  const [zoom, setZoom] = useState<TraceZoom>("week");
  /** `null` until chosen: one project's trace reads best by person, the
   *  Organisation's by project. */
  const [groupByChoice, setGroupBy] = useState<TraceGroupBy | null>(null);
  const groupBy = groupByChoice ?? (projectFilter ? "person" : "project");

  const trace = useTraceData({
    refresh: boardSessions,
    projectPaths,
    projectsKey,
    projectFilter,
    directory,
    rangeChoice,
    agent,
    people,
  });

  /** A trace row by Session id, both halves folded — what opening needs. */
  const rows = useMemo(
    () => new Map(foldTraceRows(trace.rows).map((r) => [r.id, r])),
    [trace.rows],
  );

  // The block memoizes its lanes on the callbacks, so they stay the same
  // functions across refreshes and read the latest rows through a ref; a new
  // read re-renders a lane through its session, not through these. Written
  // during render, so a lane drawn in this pass reads this pass's rows.
  const latest = useRef({ rows, boardSessions, onOpen });
  latest.current = { rows, boardSessions, onOpen };

  /** Where to open a Session: its checkout here if it has one (faster, and
   *  works offline), else the server Workspace. */
  const targetFor = useCallback((sessionId: string): OpenSession | null => {
    const { rows, boardSessions } = latest.current;
    const row = rows.get(sessionId);
    if (!row) return null;
    const remoteProjectId = row.workspaceId || null;
    const board = boardSessions.find(
      (s) => s.id === sessionId && (!remoteProjectId || s.remoteProjectId === remoteProjectId),
    );
    return {
      sessionId,
      projectPath: row.projectPath ?? board?.projectPath ?? "",
      remoteProjectId: remoteProjectId ?? board?.remoteProjectId ?? null,
    };
  }, []);

  const onOpenSession = useCallback(
    (id: string) => {
      const target = targetFor(id);
      if (target) latest.current.onOpen(target);
    },
    [targetFor],
  );
  // Opened at the Checkpoint rather than the top: the reader scrolls to the
  // commit, the same landing a commit's "Produced by" card gets.
  const onOpenCheckpoint = useCallback(
    (cp: TraceCheckpoint) => {
      const target = targetFor(cp.sessionId);
      if (target) latest.current.onOpen(cp.sha ? { ...target, commitSha: cp.sha } : target);
    },
    [targetFor],
  );

  const renderAvatar = useCallback(
    (author: TraceAuthor, size: number) => {
      const member = directory.byId.get(author.id);
      if (member) return <AccountAvatar user={avatarOf(member)} size={size} />;
      // Someone the roster cannot name — left the Organisation, or a roster
      // that has not loaded. A neutral mark, never a guessed face.
      return <AccountAvatarView name="" email="" src={null} size={size} />;
    },
    [directory],
  );

  const renderAgentMark = useCallback((s: TraceSession) => {
    const id = latest.current.rows.get(s.id)?.agent;
    return id ? <AgentGlyph agent={id} size={12} /> : null;
  }, []);

  // A failed read with nothing held is the block's error state; a failed
  // refresh over a read still held (even one the pills empty) is a strip.
  const blocking = trace.error && trace.rows.length === 0;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {filters && (
        <DestinationActions>
          <div className="flex shrink-0 items-center gap-2">{filters}</div>
        </DestinationActions>
      )}
      {trace.error && !blocking && (
        <p className="shrink-0 bg-error-muted px-4 py-1.5 text-xs text-error">
          Couldn't read the trace: {trace.error}
        </p>
      )}
      <CheckpointTrace
        sessions={trace.sessions}
        range={trace.range}
        onRangeChange={setRange}
        zoom={zoom}
        onZoomChange={setZoom}
        groupBy={groupBy}
        toolbar={
          <Segmented
            value={groupBy}
            onValueChange={setGroupBy}
            options={GROUPINGS}
            size="sm"
            aria-label="Group by"
          />
        }
        onOpenSession={onOpenSession}
        onOpenCheckpoint={onOpenCheckpoint}
        renderAvatar={renderAvatar}
        renderAgentMark={renderAgentMark}
        loading={trace.loading}
        error={blocking ? trace.error : undefined}
      />
      {trace.notes.length > 0 && (
        // Say what is being left out, as the list does — a Workspace the
        // server could not reach reads as one with no work otherwise.
        <div className="shrink-0 px-4 pb-3 text-center text-2xs text-muted-foreground">
          {trace.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}
