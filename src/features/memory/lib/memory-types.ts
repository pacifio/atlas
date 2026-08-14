// Wire types mirroring src-tauri/src/commands/agent_memory.rs. Shared by the
// Memory panel views and the memory cache store.

export interface MemoryFile {
  name: string;
  title: string;
  description: string;
  kind: string;
  body: string;
  modified_ms: number;
}
export interface ClaudeMemory {
  memory_dir: string;
  index: string | null;
  entries: MemoryFile[];
  project_md: string | null;
  global_md: string | null;
}
export interface CodexThread {
  id: string;
  title: string;
  first_user_message: string;
  model: string;
  git_branch: string | null;
  approval_mode: string;
  tokens_used: number;
  created_at: number;
  updated_at: number;
}
export interface CodexMemory {
  db_path: string | null;
  agents_md: string | null;
  global_agents_md: string | null;
  threads: CodexThread[];
}
export interface AgentMemory {
  claude: ClaudeMemory;
  codex: CodexMemory;
}

export type MemorySubTab =
  | "claude"
  | "codex"
  | "cersei"
  | "opencode"
  | "cursor"
  | "kilo"
  | "graph"
  | "policy"
  | "timeline"
  | "shared"
  | "chat"
  // Registry-installed external agents: their plugin id is their sub-tab
  // (rendered via the generic CaptureSessionsView).
  | (string & {});
