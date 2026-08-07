// Thin TS wrapper around the `memory_graph` Tauri commands (embedding-model
// download + status, index build/query, layout) and the download stream events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MemoryGraphData } from "../components/memory-graph-canvas";

export interface EmbedStatus {
  downloaded: boolean;
  model: string;
  model_dir: string;
}

export interface DownloadProgress {
  file: string;
  file_index: number;
  file_count: number;
  received: number;
  total: number;
}

export interface DownloadDone {
  success: boolean;
  error: string | null;
}

export interface QueryHit {
  id: string;
  score: number;
}

export const memoryGraph = {
  embedStatus: () => invoke<EmbedStatus>("memory_embed_status"),
  embedDownload: () => invoke<void>("memory_embed_download"),
  buildIndex: (projectPath: string) =>
    invoke<MemoryGraphData & { dim: number; doc_count: number }>("memory_index_build", {
      projectPath,
    }),
  query: (projectPath: string, query: string, topK = 12) =>
    invoke<QueryHit[]>("memory_index_query", { projectPath, query, topK }),
};

export const listenMemoryEmbedProgress = (
  handler: (p: DownloadProgress) => void,
): Promise<UnlistenFn> =>
  listen<DownloadProgress>("atlas:memory-embed:progress", (e) => handler(e.payload));

export const listenMemoryEmbedDone = (handler: (p: DownloadDone) => void): Promise<UnlistenFn> =>
  listen<DownloadDone>("atlas:memory-embed:done", (e) => handler(e.payload));
