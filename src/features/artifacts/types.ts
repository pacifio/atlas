/**
 * The wire shapes of Atlas Artifacts, mirroring `atlas_checkpoint::timeline`.
 *
 * Hand-written rather than generated because the Rust side is the contract and
 * these are the only consumers of it — a codegen step for two structs would cost
 * more than it saves. The `#[serde(rename_all = "camelCase")]` on each Rust
 * struct is what makes these field names correct; changing one without the other
 * is the failure mode to watch for.
 */

export type EntryKind = "prompt" | "response" | "thinking" | "tool_call" | "checkpoint";

export type ToolStatus = "pending" | "running" | "completed" | "failed";

export type LinkState = "linked" | "orphaned";

/** One row in the Sessions list. */
export interface SessionSummary {
  id: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  /** `acp`, `native` or `external_jsonl`. */
  source: string;
  startedAt: string;
  /** When the row was last *written*. Liveness only — never group or sort on
   *  it: an import or a token update bumps it and neither is work. */
  updatedAt: string;
  /** When the Session last did work. The key for ordering and day grouping. */
  lastActivityAt: string;
  /** Agent time — turn spans when the agent reported them, otherwise the
   *  gap-capped sum of message intervals. Not the wall-clock span. */
  activeSeconds: number;
  /** First activity to last, idle included. Usually much larger. */
  wallSeconds: number;
  messageCount: number;
  toolCallCount: number;
  checkpointCount: number;
  /** Every branch touched: the starting branch first, then Checkpoint branches. */
  branches: string[];
  insertions: number;
  deletions: number;
  filesTouched: number;
  /** Input + output. `0` for an agent that reports no split — see `contextUsed`. */
  totalTokens: number;
  /** The halves of `totalTokens`, kept apart because they are priced apart —
   *  an Opus output token costs five times an input one. */
  inputTokens: number;
  outputTokens: number;
  /** Cache writes and cache reads. Real spend, carried beside the split rather
   *  than inside it — for a cache-heavy agent they dwarf both. */
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Context-window occupancy, for agents that report only that (every ACP
   *  agent). Deliberately not folded into `totalTokens`: occupancy is not
   *  consumption, and a compaction makes it go down. */
  contextUsed: number | null;
  contextSize: number | null;
  needsAttention: boolean;
  attentionReason: string | null;
}

/** One thing that happened inside a Session. */
export interface TimelineEntry {
  id: string;
  kind: EntryKind;
  at: string;
  turnSeq: number;

  text: string | null;
  /** `text` is the 2 KB preview; the body was too large to send. */
  truncated: boolean;
  bodyBytes: number;
  /** Blob key of the spilled full body — fetch via `artifacts_payload`. */
  bodyRef: string | null;

  toolName: string | null;
  toolTitle: string | null;
  toolStatus: ToolStatus | null;
  paths: string[];
  arguments: string | null;
  argumentsRef: string | null;
  result: string | null;
  /** Blob key of the spilled full result — fetch via `artifacts_payload`. */
  resultRef: string | null;
  resultBinary: boolean;

  commitSha: string | null;
  commitSubject: string | null;
  branch: string | null;
  linkState: LinkState | null;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface EntryCounts {
  prompts: number;
  responses: number;
  thinking: number;
  toolCalls: number;
  checkpoints: number;
}

export interface ToolTally {
  toolName: string;
  count: number;
}

export interface SessionDetail {
  summary: SessionSummary;
  entries: TimelineEntry[];
  counts: EntryCounts;
  tools: ToolTally[];
}

/** One spilled payload, fetched on demand — mirrors `ArtifactPayload`. */
export interface ArtifactPayload {
  /** The payload as text, or `null` when it is not valid UTF-8. */
  text: string | null;
  binary: boolean;
  bytes: number;
}

/** Which entry kinds the timeline is currently showing. */
export interface TimelineFilters {
  prompts: boolean;
  responses: boolean;
  thinking: boolean;
  toolCalls: boolean;
  checkpoints: boolean;
}

/**
 * Thinking is off by default: it is the bulk of the bytes in a Session and
 * almost never what someone opened the timeline to read. Everything else is on,
 * because a timeline that hides work by default is the silence this feature
 * exists to end.
 */
export const DEFAULT_FILTERS: TimelineFilters = {
  prompts: true,
  responses: true,
  thinking: false,
  toolCalls: true,
  checkpoints: true,
};

/**
 * One Checkpoint on the board — mirrors `atlas_checkpoint::CheckpointRow` plus
 * the project tag `commands::capture::BoardCheckpoint` adds.
 *
 * Deliberately smaller than a `TimelineEntry`: this is a jump target, not a
 * reading surface.
 */
export interface BoardCheckpoint {
  sessionId: string;
  /** The Session's title, so a row says which work produced the commit. */
  sessionTitle: string | null;
  commitSha: string;
  /** Read from git at display time; `null` if the repo moved or the commit is gone. */
  commitSubject: string | null;
  branch: string | null;
  linkState: LinkState;
  insertions: number;
  deletions: number;
  files: number;
  at: string;
  projectPath: string;
  projectName: string;
}

/**
 * A board row: a Session plus the project it came from.
 *
 * The board spans every project in the Organisation, so a row can no longer
 * assume the open Project — reading the Session back needs its own store.
 */
export interface BoardSession extends SessionSummary {
  /** Empty for a Session from a Project this machine has no checkout of. */
  projectPath: string;
  projectName: string;
  /**
   * Is this Session on the server?
   *
   * Project-level, not row-level: "has every row drained" would cost an outbox
   * scan per Session on a read that runs on every capture event, to answer a
   * question nobody asked. The queue depth is `CaptureHealth.pendingRows`.
   */
  synced: boolean;
  origin: SessionOrigin;
  /** The server Project id, for cloud reads and the realtime socket. */
  remoteProjectId: string | null;
  /** `null` on a local row — a Session on this disk is this account's. */
  authorId: string | null;
}

/**
 * What the board is narrowed to — mirrors `commands::capture::BoardFilter`.
 *
 * A Project with a checkout here is its folder; one the Organisation has and
 * this machine does not has no folder, only its server id.
 */
export type ProjectFilter = { local: string } | { remote: string };

/** The filter that selects a row's Project, or `null` for a row that names
 *  neither a folder nor a server Project. */
export function projectFilterFor(row: BoardSession): ProjectFilter | null {
  if (row.projectPath) return { local: row.projectPath };
  if (row.remoteProjectId) return { remote: row.remoteProjectId };
  return null;
}

/** A string that identifies a filter, for keys and equality. */
export function projectFilterKey(filter: ProjectFilter): string {
  return "local" in filter ? `local:${filter.local}` : `remote:${filter.remote}`;
}

/**
 * Where a board row was read from.
 *
 * `both` is the normal state of your own work once a Project is synced. It
 * matters because such a row can be opened from disk — faster, and offline —
 * while still carrying comments.
 */
export type SessionOrigin = "local" | "remote" | "both";

/**
 * One board read — mirrors `commands::capture::BoardPage`.
 *
 * `cloudPending` is the difference between "this Organisation has no Sessions"
 * and "the remote half has not arrived yet". A synced Organisation has no local
 * rows to show while its first server read is in flight, and an empty board at
 * that moment must render as loading rather than as empty.
 */
export interface BoardPage {
  sessions: BoardSession[];
  cloudPending: boolean;
  /**
   * The remote half could not be read at all.
   *
   * The rows are this machine's, plus whatever an earlier refresh cached — a
   * partial view that has to be labelled rather than presented as the whole
   * board. Goes false again the moment any refresh succeeds.
   */
  cloudFailed: boolean;
}

/**
 * One page of the Trace — mirrors `atlas_artifacts::TracePage`, which is the
 * server's `GET /sessions/trace` answer passed through, plus this machine's
 * own Sessions on the first page.
 */
export interface TracePage {
  from: string;
  to: string;
  sessions: TraceSessionRow[];
  workspaces: { id: string; slug: string | null; name: string | null; number: number | null }[];
  /** `null` on the last page. */
  nextCursor: string | null;
  /** Caveats — a Workspace the server could not reach, or the server half
   *  not being readable at all. Said, not swallowed. */
  notes: string[];
}

/** One Session on the Trace — mirrors `atlas_artifacts::TraceSession`. */
export interface TraceSessionRow {
  id: string;
  number: number | null;
  /** The server Workspace; empty for a row read from an unbound checkout. */
  workspaceId: string;
  workspaceSlug: string | null;
  /** `null` on a row read from this disk — that work is this account's. */
  authorId: string | null;
  /** User ids, the author first. Empty on a row read from this disk. */
  participants: string[];
  title: string | null;
  agent: string | null;
  source: string | null;
  startedAt: string;
  /** There is no stored end: a finished Session ends here. */
  lastActivityAt: string;
  live: boolean;
  incomplete: boolean;
  checkpoints: TraceCheckpointRow[];
  /** The server sent this Session's newest Checkpoints, not all of them. */
  checkpointsTruncated: boolean;
  /** Host-only: the checkout a row read from disk came from. Absent on the
   *  server's rows. */
  projectPath?: string;
}

/** One Checkpoint on the Trace — mirrors `atlas_artifacts::TraceCheckpoint`. */
export interface TraceCheckpointRow {
  id: string;
  sessionId: string;
  at: string;
  /** `null` on a row read from this disk. */
  authorId: string | null;
  commitSha: string;
  branch: string | null;
  linkState: LinkState;
  insertions: number;
  deletions: number;
  files: number;
  /** Host-only: read from git on this machine. The server has no subject. */
  commitSubject?: string | null;
}
