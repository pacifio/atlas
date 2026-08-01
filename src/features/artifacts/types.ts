/**
 * The wire shapes of Atlas Artifacts, mirroring `atlas_checkpoint::timeline`.
 *
 * Hand-written rather than generated because the Rust side is the contract and
 * these are the only consumers of it — a codegen step for two structs would cost
 * more than it saves. The `#[serde(rename_all = "camelCase")]` on each Rust
 * struct is what makes these field names correct; changing one without the other
 * is the failure mode to watch for.
 */

export type EntryKind =
  | "prompt"
  | "response"
  | "thinking"
  | "tool_call"
  | "checkpoint";

export type ToolStatus = "pending" | "running" | "completed" | "failed";

export type LinkState = "linked" | "orphaned";

/** One row in the Sessions list. */
export interface SessionSummary {
  id: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  /** `acp`, `cersei` or `external_jsonl`. */
  source: string;
  startedAt: string;
  updatedAt: string;
  durationSeconds: number;
  messageCount: number;
  toolCallCount: number;
  checkpointCount: number;
  branches: string[];
  insertions: number;
  deletions: number;
  filesTouched: number;
  totalTokens: number;
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
 * A board row: a Session plus the project it came from.
 *
 * The board spans every project in the Organisation, so a row can no longer
 * assume the open Workspace — reading the Session back needs its own store.
 */
export interface BoardSession extends SessionSummary {
  projectPath: string;
  projectName: string;
}
