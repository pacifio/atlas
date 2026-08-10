import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface MemoryChatSessionWire {
  id: string;
  title: string;
  projectPath: string;
  /** "local" | "provider" */
  mode: string;
  provider: string;
  model: string;
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
}

/** Result of provider-mode retrieval: a ready-to-send augmented prompt + sources. */
export interface RetrieveResult {
  prompt: string;
  sources: SourceRef[];
}

export interface ChatModelStatus {
  downloaded: boolean;
  model: string;
}

export interface DownloadProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number;
}

export interface DownloadDone {
  success: boolean;
  error?: string | null;
}

/** A memory document used as context for an answer. */
export interface SourceRef {
  id: string;
  title: string;
  source: string;
  score: number;
  /** Absolute path of the backing file (memory `.md` or codebase file), if any. */
  filePath?: string | null;
}

/** Inference backend the local model runs on. */
export type ChatBackend = "metal" | "cpu";

/** Streaming events from Rust, tagged by `stream_id`. */
export type MemoryChatEvent =
  | { stream_id: string; kind: "sources"; sources: SourceRef[] }
  | { stream_id: string; kind: "backend"; backend: ChatBackend }
  | { stream_id: string; kind: "text_delta"; delta: string }
  | { stream_id: string; kind: "done" }
  | { stream_id: string; kind: "error"; message: string };

export interface MemoryWireMsg {
  role: string;
  content: string;
}

export const memoryChat = {
  modelStatus: () => invoke<ChatModelStatus>("memory_chat_model_status"),
  modelDownload: () => invoke<void>("memory_chat_model_download"),
  modelLoad: () => invoke<ChatBackend>("memory_chat_model_load"),
  /** Backend of the cached model, or null if not loaded yet. */
  backend: () => invoke<ChatBackend | null>("memory_chat_backend"),
  send: (streamId: string, projectPath: string, messages: MemoryWireMsg[]) =>
    invoke<void>("memory_chat_send", { streamId, projectPath, messages }),
  retrieve: (projectPath: string, query: string) =>
    invoke<RetrieveResult>("memory_chat_retrieve", { projectPath, query }),
  cancel: (streamId: string) => invoke<void>("memory_chat_cancel", { streamId }),

  sessionsList: () => invoke<SessionMeta[]>("memory_chat_sessions_list"),
  sessionGet: (id: string) => invoke<MemoryChatSessionWire>("memory_chat_session_get", { id }),
  sessionSave: (session: MemoryChatSessionWire) =>
    invoke<void>("memory_chat_session_save", { session }),
  sessionDelete: (id: string) => invoke<void>("memory_chat_session_delete", { id }),
};

export const listenMemoryChat = (handler: (e: MemoryChatEvent) => void): Promise<UnlistenFn> =>
  listen<MemoryChatEvent>("atlas:memory-chat", (e) => handler(e.payload));

export const listenChatModelProgress = (
  handler: (p: DownloadProgress) => void,
): Promise<UnlistenFn> =>
  listen<DownloadProgress>("atlas:memory-chat-model:progress", (e) => handler(e.payload));

export const listenChatModelDone = (handler: (d: DownloadDone) => void): Promise<UnlistenFn> =>
  listen<DownloadDone>("atlas:memory-chat-model:done", (e) => handler(e.payload));
