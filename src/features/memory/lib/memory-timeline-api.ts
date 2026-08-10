import { invoke } from "@tauri-apps/api/core";

export interface TimelineBranch {
  name: string;
  is_current: boolean;
}
export interface TimelineCommit {
  sha: string;
  short: string;
  message: string;
  branch: string;
  ts_ms: number;
  refs: string[];
}
export interface TimelineSession {
  id: string;
  title: string;
  agent: "codex" | "claude" | "cersei" | "opencode" | "cursor" | "kilo";
  branch: string | null;
  sha: string | null;
  ts_ms: number;
  end_ms: number;
  detail: string;
}
export interface TimelineMemory {
  id: string;
  title: string;
  source: string; // "claude" | "codex"
  kind: string;
  ts_ms: number;
}
export interface MemoryTimeline {
  branches: TimelineBranch[];
  commits: TimelineCommit[];
  sessions: TimelineSession[];
  memory: TimelineMemory[];
}

export const memoryTimeline = {
  /** Fresh compute (git + sqlite). Also persists a disk cache on the Rust side. */
  load: (projectPath: string) => invoke<MemoryTimeline>("memory_timeline", { projectPath }),
  /** Instant read of the last-persisted timeline (null if none). */
  loadCached: (projectPath: string) =>
    invoke<MemoryTimeline | null>("memory_timeline_cached", { projectPath }),
};
