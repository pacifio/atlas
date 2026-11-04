/**
 * The boundary to `@tryatlas/design`'s `CheckpointTrace` block.
 *
 * The gantt itself is designed and built in the package. Until the release
 * that ships it is pinned, this file carries the block's draft prop types and
 * renders a plain placeholder — deliberately not a desktop copy of the chart,
 * which would be a second design of the same thing.
 *
 * Adopting the block is this one file: replace everything below with
 * re-exports of the component and its types from the package. Nothing else in
 * the feature imports from the package for it.
 */

import type { ReactNode } from "react";

export type TraceAuthor = { id: string; name: string; avatarUrl?: string | null };

export type TraceCheckpoint = {
  id: string;
  sessionId: string;
  /** ISO time the Checkpoint landed. */
  at: string;
  /** Who drove the Session when it landed. */
  author: TraceAuthor;
  /** Commit subject, where this machine's git has one; the block falls back
   *  to the short sha. */
  title?: string;
  sha?: string | null;
  branch?: string | null;
  /** `orphaned` once the commit is gone from history. */
  linkState?: "linked" | "orphaned";
  additions?: number;
  deletions?: number;
  files?: number;
};

export type TraceSession = {
  id: string;
  title: string;
  projectId?: string | null;
  projectName?: string | null;
  agentLabel?: string | null;
  startedAt: string;
  /** `null` while the Session is live. */
  endedAt?: string | null;
  status?: "live" | "settled" | "error";
  participants: TraceAuthor[];
  checkpoints: TraceCheckpoint[];
  /** Only the newest Checkpoints were sent. */
  checkpointsTruncated?: boolean;
};

export type TraceZoom = "hour" | "day" | "week";
export type TraceGroupBy = "none" | "project" | "person";
export type TraceRangeValue = { from: string; to: string };

export interface CheckpointTraceProps {
  sessions: TraceSession[];
  range: TraceRangeValue;
  onRangeChange: (range: TraceRangeValue) => void;
  zoom: TraceZoom;
  onZoomChange: (zoom: TraceZoom) => void;
  groupBy: TraceGroupBy;
  onGroupByChange?: (groupBy: TraceGroupBy) => void;
  now?: string;
  onOpenSession: (sessionId: string) => void;
  onOpenCheckpoint: (checkpoint: TraceCheckpoint) => void;
  renderAvatar: (author: TraceAuthor, sizePx: number) => ReactNode;
  renderAgentMark?: (session: TraceSession) => ReactNode;
  loading?: boolean;
  empty?: ReactNode;
  labels?: Record<string, string>;
}

/** Placeholder until the package block is released. */
export function CheckpointTrace({ sessions, loading, empty }: CheckpointTraceProps) {
  const checkpoints = sessions.reduce((n, s) => n + s.checkpoints.length, 0);
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center text-xs text-muted-foreground">
      {loading
        ? "Reading the trace…"
        : sessions.length === 0
          ? (empty ?? "Nothing in this range.")
          : `Trace: ${sessions.length} sessions, ${checkpoints} checkpoints in this range.`}
    </div>
  );
}
