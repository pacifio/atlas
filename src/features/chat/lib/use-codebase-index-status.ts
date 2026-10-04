import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface CodebaseIndexStatus {
  indexed: boolean;
  // Rust serializes this struct as camelCase (see code_index/mod.rs).
  fileCount: number;
  summaryCount: number;
  builtAtMs: number;
}

/** Bursts of index jobs (a save storm, a branch switch) collapse into one fetch. */
const DEBOUNCE_MS = 300;

/** The code index status for one project. The progress event and window
 *  focus only mean "something may have changed": the hook always re-reads
 *  `codebase_index_status`, so a missed event costs freshness, never truth. */
export function useCodebaseIndexStatus(projectPath: string | null) {
  const [status, setStatus] = useState<CodebaseIndexStatus | null>(null);
  const current = useRef(projectPath);
  current.current = projectPath;

  const refresh = useCallback(() => {
    if (!projectPath) return;
    const asked = projectPath;
    invoke<CodebaseIndexStatus>("codebase_index_status", { projectPath: asked })
      .then((s) => {
        if (current.current === asked) setStatus(s);
      })
      .catch(() => {});
  }, [projectPath]);

  useEffect(() => {
    setStatus(null);
    refresh();
    if (!projectPath) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    };
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen("atlas:codebase-index:progress", soon).then((u) => {
      if (gone) u();
      else unlisten = u;
    });
    window.addEventListener("focus", soon);
    return () => {
      gone = true;
      clearTimeout(timer);
      unlisten?.();
      window.removeEventListener("focus", soon);
    };
  }, [projectPath, refresh]);

  return { status, refresh };
}
