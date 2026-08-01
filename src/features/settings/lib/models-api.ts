// Local Model Manager API — thin wrappers over the Rust `models` commands and the
// generic download events. Mirrors the memory-graph / byok api style.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ModelKind = "embedding" | "llm";

export interface FileSpec {
  repo: string;
  file: string;
  dest: string;
}

export interface ModelEntry {
  id: string;
  kind: ModelKind;
  name: string;
  repo: string;
  files: FileSpec[];
  dim?: number;
  sizeMb: number;
  description: string;
  compatible: boolean;
}

/** A catalog entry plus per-machine state (from `models_list`). */
export interface ModelStatus extends ModelEntry {
  downloaded: boolean;
  selected: boolean;
}

export interface DownloadProgress {
  id: string;
  file: string;
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number;
}

export interface DownloadDone {
  id: string;
  success: boolean;
  error: string | null;
}

export interface SelectResult {
  needsReindex: boolean;
}

export const models = {
  list: () => invoke<ModelStatus[]>("models_list"),
  download: (id: string) => invoke<void>("model_download", { id }),
  remove: (id: string) => invoke<void>("model_remove", { id }),
  select: (id: string) => invoke<SelectResult>("model_select", { id }),
  /** Force a memory re-index of a project (after an embedding-model switch). */
  reindex: (cwd: string) => invoke<void>("force_reindex", { cwd }),
};

export const listenModelProgress = (
  cb: (p: DownloadProgress) => void,
): Promise<UnlistenFn> =>
  listen<DownloadProgress>("atlas:model-download:progress", (e) =>
    cb(e.payload),
  );

export const listenModelDone = (
  cb: (d: DownloadDone) => void,
): Promise<UnlistenFn> =>
  listen<DownloadDone>("atlas:model-download:done", (e) => cb(e.payload));

/** Fires whenever the catalog's on-disk / selection state changes. */
export const listenModelsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("atlas:models-changed", () => cb());
