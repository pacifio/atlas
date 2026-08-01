import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CodebaseIndexStatus {
  indexed: boolean;
  fileCount: number;
  summaryCount: number;
  builtAtMs: number;
}

export type CodebaseBackend = "structural" | "local" | "provider";

export interface CodebaseBuildOpts {
  mode: "full" | "incremental";
  backend: CodebaseBackend;
  provider?: string;
  model?: string;
}

export interface CodebaseIndexProgress {
  phase: string; // "scanning" | "summarizing" | "embedding" | "done"
  current: number;
  total: number;
}

export const codebaseIndex = {
  status(projectPath: string): Promise<CodebaseIndexStatus> {
    return invoke<CodebaseIndexStatus>("codebase_index_status", {
      projectPath,
    });
  },
  build(
    projectPath: string,
    opts: CodebaseBuildOpts,
  ): Promise<CodebaseIndexStatus> {
    return invoke<CodebaseIndexStatus>("codebase_index_build", {
      projectPath,
      opts,
    });
  },
};

export const listenCodebaseIndexProgress = (
  handler: (p: CodebaseIndexProgress) => void,
): Promise<UnlistenFn> =>
  listen<CodebaseIndexProgress>("atlas:codebase-index:progress", (e) =>
    handler(e.payload),
  );
