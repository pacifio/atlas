// Shared Cross-Agent Memory (v2) — TS bindings for the per-project event log
// + derived state view. The capture/injection happen Rust-side
// (`agents_send` + `TauriDeltaSink::emit`); these commands let the Memory panel
// read the current view, run an on-demand query, and clear a project's memory.
// Mirrors the plain-invoke pattern in `memory-sharing-api.ts`.

import { invoke } from "@tauri-apps/api/core";

export type EventKind =
  | "plan_set"
  | "decision"
  | "file_changed"
  | "fact"
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

export const sharedMemory = {
  getState: (projectPath: string) => invoke<SharedState>("memory_get_state", { projectPath }),
  query: (projectPath: string, query: string, limit = 20) =>
    invoke<MemoryEvent[]>("memory_query", { projectPath, query, limit }),
  listEvents: (projectPath: string) => invoke<MemoryEvent[]>("memory_list_events", { projectPath }),
  clear: (projectPath: string) => invoke<void>("memory_clear_project", { projectPath }),
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
