// Wire types + render constants for the git-graph panel.
//
// The graph LAYOUT algorithm lives in Rust:
// `src-tauri/src/commands/git_graph.rs::git_graph_build` runs `git log`
// + `git for-each-ref` in parallel, lays out lanes/segments, and ships
// a `BuiltGraph` ready to render. The frontend used to do all of this
// in `buildGraph(...)` (~300 LOC walking commits + allocating lanes
// per-row) on every git signature change — that's pure business logic
// per the "Rust owns logic" rule.
//
// These interfaces are the wire-shape projection of the Rust types
// (see git_graph.rs). Keep them in sync field-for-field.

export interface RefBadge {
  name: string;
  kind: "branch" | "remote" | "tag" | string;
  isCurrent: boolean;
}

export interface LaneSegment {
  fromLane: number;
  toLane: number;
  /** 0.0 = top, 0.5 = middle, 1.0 = bottom. Wire type is f32 in Rust;
   *  the renderer only compares for equality at 0/0.5/1. */
  fromY: number;
  toY: number;
  color: string;
}

export interface CommitRow {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  email: string;
  date: string;
  refs: RefBadge[];
  isHead: boolean;
  commitLane: number;
  commitColor: string;
  segments: LaneSegment[];
}

export interface BuiltGraph {
  rows: CommitRow[];
  laneCount: number;
  /** Every commit in scope; `rows` stops at the requested limit. */
  totalCommits: number;
}

/** "1,231 commits", or "1,000 of 1,231 commits" while the list is capped —
 *  the loaded row count alone read as the repository's size. */
export function commitCountLabel(loaded: number, total: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const noun = total === 1 ? "commit" : "commits";
  return loaded < total ? `${fmt(loaded)} of ${fmt(total)} ${noun}` : `${fmt(total)} ${noun}`;
}

// Render-only constants — used by the graph view and its commit rows.
export const LANE_WIDTH = 14;
export const ROW_HEIGHT = 28;
export const GRAPH_LEFT_PAD = 14;
