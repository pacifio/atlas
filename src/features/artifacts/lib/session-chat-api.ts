/**
 * The wire for Session-Chat — grounded chat over one recorded Session.
 *
 * Retrieval only. Generation reuses `modelchat.stream()` and `listenModelChat`
 * from the BYOK model chat, so there is deliberately no send/cancel here: a
 * second streaming path would be a second place for provider quirks, token
 * accounting and cancellation to drift.
 */

import { invoke } from "@tauri-apps/api/core";

/** One thing an answer was grounded in — mirrors `session_chat::SourceRef`. */
export interface SourceRef {
  /** `checkpoint`, `tool_call`, `prompt`, `response`, `thinking`, `file`. */
  kind: string;
  label: string;
  /** The timeline entry, so a citation can jump to it. */
  entryId: string | null;
  commitSha: string | null;
}

export interface RetrieveResult {
  /** The augmented user turn to hand to the provider. */
  prompt: string;
  sources: SourceRef[];
}

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  /** What this answer was grounded in — saved with the message so a reopened
   *  thread keeps its citations. Absent on threads written before this shipped. */
  sources?: SourceRef[];
}

/** One saved chat thread about one Session. */
export interface SessionChatThreadWire {
  id: string;
  title: string;
  agentSessionId: string;
  projectPath: string;
  provider: string;
  model: string;
  messages: StoredMessage[];
  /**
   * Commit SHAs this thread is scoped to. `null`/absent = the whole Session.
   * Persisted so reopening a thread about one Checkpoint stays about it;
   * threads written before scoping shipped have no field and read as full.
   */
  checkpointScope?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMeta {
  id: string;
  title: string;
  updatedAt: string;
}

export const sessionChat = {
  /**
   * `checkpoints` scopes the grounding to those commits' spans — the work that
   * produced them, not just their diffstats. Empty/undefined grounds on the
   * whole Session, which is what every thread did before scoping existed.
   */
  retrieve: (
    projectPath: string,
    sessionId: string,
    query: string,
    checkpoints?: string[] | null,
  ) =>
    invoke<RetrieveResult>("session_chat_retrieve", {
      projectPath,
      sessionId,
      query,
      checkpoints: checkpoints?.length ? checkpoints : null,
    }),

  threadsList: (agentSessionId: string) =>
    invoke<ThreadMeta[]>("session_chat_threads_list", { agentSessionId }),
  threadGet: (agentSessionId: string, id: string) =>
    invoke<SessionChatThreadWire>("session_chat_thread_get", { agentSessionId, id }),
  threadSave: (thread: SessionChatThreadWire) =>
    invoke<void>("session_chat_thread_save", { thread }),
  threadDelete: (agentSessionId: string, id: string) =>
    invoke<void>("session_chat_thread_delete", { agentSessionId, id }),
};
