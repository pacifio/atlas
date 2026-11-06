// Shared Cross-Agent Memory (v2) — TS bindings for the per-project event log
// + derived state view. Capture happens Rust-side (the delta middleware in
// `agents.rs`); agents pull memory through the `atlas_memory` tools, nothing is
// injected (ADR-0010). These commands let the Memory panel read the current
// view, run an on-demand query, and clear a project's memory.
// Mirrors the plain-invoke pattern in `memory-sharing-api.ts`.

import { invoke } from "@tauri-apps/api/core";

export type EventKind =
  | "plan_set"
  | "decision"
  | "file_changed"
  | "fact"
  | "failure"
  | "architecture"
  | "preference"
  | "session_start"
  | "session_end"
  | "todo_added"
  | "todo_done";

export interface MemoryEvent {
  seq: number;
  ts: number;
  agent: string;
  sessionId: string;
  kind: EventKind;
  key: string;
  payload: Record<string, unknown>;
}

export interface PlanView {
  seq: number;
  agent: string;
  text: string;
  status: string;
}

export interface DecisionView {
  seq: number;
  agent: string;
  key: string;
  text: string;
}

export interface ChangeView {
  seq: number;
  agent: string;
  path: string;
  summary: string;
}

export interface FactView {
  seq: number;
  agent: string;
  text: string;
}

export interface SharedState {
  lastSeq: number;
  activePlan?: PlanView | null;
  decisions: DecisionView[];
  recentChanges: ChangeView[];
  facts: FactView[];
  failures: FactView[];
  architecture: FactView[];
  sessionAgents: Record<string, string>;
  updatedAt: number;
}

/** Which of the six kinds a record entry is. */
export type EntryKind =
  | "plan"
  | "decision"
  | "file_changed"
  | "fact"
  | "failure"
  | "architecture"
  | "preference";

/** One record entry with its provenance and confidence (the Memories view). */
export interface MemoryEntry {
  id: number;
  kind: EntryKind;
  key: string;
  content: string;
  status: string;
  /** An agent id, `extractor`, `user`, or `import:<origin>`. */
  source: string;
  /** The agent the memory came from; empty for an import. */
  agent: string;
  sessionId: string;
  /** 0–1: the extractor's model confidence; 1 for tool and user writes. */
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  uses: number;
  /** The revision the entry currently is. */
  revision: number;
  /** `active`, `candidate` (captured, not confirmed) or `archived`. */
  state: "active" | "candidate" | "archived";
}

/** Where a memory was learned: the session that wrote it, resolved against the
 *  session recorder when capture records the project. */
export interface Provenance {
  /** `atlas-session:<agent>/<session>`, `atlas-user`, or a raw source. */
  source: string;
  agent: string;
  /** `YYYY-MM-DD`. */
  added: string | null;
  /** The recorded session's title (its first prompt), when recorded. */
  title: string | null;
  /** The commits that session produced, newest first (12 hex). */
  commits: string[];
}

/** Near-duplicates the user may merge into `keep` (the Review tab). */
export interface MergeProposal {
  keep: MemoryEntry;
  drop: MemoryEntry[];
}

/** Two current memories linked as contradicting each other. */
export interface ConflictPair {
  a: MemoryEntry;
  b: MemoryEntry;
}

/** One change the nightly review proposed, with the entries it names. */
export interface DreamProposal {
  id: number;
  /** The operation as proposed: `{ op: "add" | "merge" | "archive" | "rewrite" | "link", … }`. */
  op: { op: string; content?: string; reason?: string; rel?: string; kind?: string };
  why: string;
  entries: MemoryEntry[];
}

/** What waits for the user in the Review tab. */
export interface ReviewQueue {
  candidates: MemoryEntry[];
  merges: MergeProposal[];
  conflicts: ConflictPair[];
  dreams: DreamProposal[];
}

/** What exporting memories to AGENTS.md would do. */
export interface ExportPreview {
  path: string;
  before: string;
  after: string;
}

/** One line importing an Agent Memory Repo would write. */
export interface RepoImportLine {
  id: string;
  kind: EntryKind;
  content: string;
  /** The file it came from, relative to the chosen folder. */
  file: string;
  /** The line's own metadata (`key: value; …`), empty when none. Untrusted:
   *  kept as provenance, never as who wrote it. */
  meta: string;
  /** `false` when memory already holds it: confirm skips it. */
  isNew: boolean;
}

/** A verdict on a memory after using it. */
export type Verdict = "useful" | "wrong" | "stale";

/** One line an import of Claude's auto-memory would write (the preview). */
export interface ClaudeImportLine {
  /** Stable id of the line; what confirm takes. */
  id: string;
  /** `fact`, or `decision` for a project memory that states a choice. */
  kind: EntryKind;
  content: string;
  /** The Claude memory file it came from. */
  file: string;
  /** Claude's own frontmatter `type` (`user`, `feedback`, `project`, `reference`). */
  claudeType: string;
  /** `false` when already imported or already in memory: confirm skips it. */
  isNew: boolean;
}

export interface ClaudeImportPreview {
  /** The Claude memory directories read for this repository. */
  sources: string[];
  /** Every source was imported before (once per source). */
  alreadyImported: boolean;
  lines: ClaudeImportLine[];
}

export const sharedMemory = {
  getState: (projectPath: string) => invoke<SharedState>("memory_get_state", { projectPath }),
  query: (projectPath: string, query: string, limit = 20) =>
    invoke<MemoryEvent[]>("memory_query", { projectPath, query, limit }),
  listEvents: (projectPath: string) => invoke<MemoryEvent[]>("memory_list_events", { projectPath }),
  clear: (projectPath: string) => invoke<void>("memory_clear_project", { projectPath }),
  listEntries: (projectPath: string) =>
    invoke<MemoryEntry[]>("memory_list_entries", { projectPath }),
  /** Rewrite an entry's content as the user (source `user`, confidence 1). */
  editEntry: (projectPath: string, id: number, content: string) =>
    invoke<MemoryEntry>("memory_edit_entry", { projectPath, id, content }),
  /** Forget (delete) an entry. `false` when it was already gone. */
  forgetEntry: (projectPath: string, id: number) =>
    invoke<boolean>("memory_forget_entry", { projectPath, id }),
  /** Forget an entry and erase its text from every table of the record
   *  ("Erase with history"). `false` when there was nothing to erase. */
  purgeEntry: (projectPath: string, id: number) =>
    invoke<boolean>("memory_purge_entry", { projectPath, id }),
  /** Where an entry was learned (read-only from the session recorder). */
  provenance: (projectPath: string, id: number) =>
    invoke<Provenance[]>("memory_entry_provenance", { projectPath, id }),
  /** Candidates, merge proposals and contradictions waiting for review. */
  review: (projectPath: string) => invoke<ReviewQueue>("memory_review", { projectPath }),
  /** Approve a candidate (or restore an archived memory). */
  promote: (projectPath: string, id: number) =>
    invoke<boolean>("memory_promote", { projectPath, id }),
  /** Dismiss memories: archived, kept in history. Returns how many changed. */
  archive: (projectPath: string, ids: number[]) =>
    invoke<number>("memory_archive", { projectPath, ids }),
  /** Merge near-duplicates into `keep`: the others are archived as superseded. */
  merge: (projectPath: string, keep: number, drop: number[]) =>
    invoke<number>("memory_merge", { projectPath, keep, drop }),
  /** Settle a contradiction: keep one side, or record that both hold. */
  resolveConflict: (projectPath: string, a: number, b: number, keep: "a" | "b" | "both") =>
    invoke<boolean>("memory_resolve_conflict", { projectPath, a, b, keep }),
  /** The AGENTS.md export of `ids`: the file now and after. Writes nothing. */
  exportPreview: (projectPath: string, ids: number[]) =>
    invoke<ExportPreview>("memory_export_preview", { projectPath, ids }),
  /** Write `ids` into AGENTS.md's managed block. Returns the file's path. */
  exportApply: (projectPath: string, ids: number[]) =>
    invoke<string>("memory_export_apply", { projectPath, ids }),
  /** Accept a nightly-review proposal: `"accepted"`, or `"obsolete"` when
   *  memory moved on since and nothing was written. */
  acceptDream: (projectPath: string, id: number) =>
    invoke<string>("memory_dream_accept", { projectPath, id }),
  /** Dismiss a nightly-review proposal. */
  dismissDream: (projectPath: string, id: number) =>
    invoke<void>("memory_dream_dismiss", { projectPath, id }),
  /** The user's verdict on one entry. `null` for an unknown id. */
  feedback: (projectPath: string, id: number, verdict: Verdict) =>
    invoke<MemoryEntry | null>("memory_feedback_entry", { projectPath, id, verdict }),
  /** What importing the Agent Memory Repo at `dir` would write. Writes nothing. */
  previewRepoImport: (projectPath: string, dir: string) =>
    invoke<RepoImportLine[]>("memory_repo_import_preview", { projectPath, dir }),
  /** Import the chosen lines as candidates. Returns how many were written. */
  confirmRepoImport: (projectPath: string, dir: string, ids: string[]) =>
    invoke<number>("memory_repo_import_confirm", { projectPath, dir, ids }),
  /** What importing the project's Claude auto-memory would write. Writes nothing. */
  previewClaudeImport: (projectPath: string) =>
    invoke<ClaudeImportPreview>("memory_claude_import_preview", { projectPath }),
  /** Import the previewed lines in `ids` (source `import:claude`, confidence 0.7).
   *  Returns how many were written. */
  confirmClaudeImport: (projectPath: string, ids: string[]) =>
    invoke<number>("memory_claude_import_confirm", { projectPath, ids }),
  appendEvent: (
    projectPath: string,
    agent: string,
    sessionId: string,
    kind: EventKind,
    key: string | null,
    payload: Record<string, unknown>,
  ) =>
    invoke<number>("memory_append_event", {
      projectPath,
      agent,
      sessionId,
      kind,
      key,
      payload,
    }),
};
