// The files a session changed, as the capture record has them.
//
// The Details card's Changes section used to derive this list from tool arguments in the
// renderer, which only ever saw Write/Edit calls: a `sed -i`, a heredoc or a
// script changed files the rail never listed. The recorder (`capture.rs`)
// attributes those by watching the tree around the shell call, so its record
// is the complete answer — read here, and refreshed on `atlas:capture-changed`
// the way the Memories card refreshes on `atlas:memory-changed`.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** One file the session changed. Mirrors `commands::capture::SessionFile`. */
export interface SessionFile {
  /** Project-relative, git's spelling. */
  path: string;
  created: boolean;
  deleted: boolean;
  outOfRepo: boolean;
  turns: number;
  lastTurnSeq: number;
  /** Null when the record holds no patch for the path (a shell edit). */
  added: number | null;
  removed: number | null;
}

const EMPTY: SessionFile[] = [];
const DEBOUNCE_MS = 300;

/** The record's file list for an agent session, or empty when capture is off
 *  for the project or the session was never recorded. */
export async function fetchSessionFiles(
  projectPath: string,
  sessionId: string,
): Promise<SessionFile[]> {
  // An unmocked command resolves null in the browser harness.
  return (
    (await invoke<SessionFile[] | null>("capture_session_files", { projectPath, sessionId })) ??
    EMPTY
  );
}

export function useSessionFiles(
  projectPath: string | null,
  sessionId: string | null,
): SessionFile[] {
  const [files, setFiles] = useState<SessionFile[]>(EMPTY);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!projectPath || !sessionId) return;
    const mine = ++seq.current;
    try {
      const next = await fetchSessionFiles(projectPath, sessionId);
      if (mine === seq.current) setFiles(next);
    } catch {
      // A failed read keeps the last answer.
    }
  }, [projectPath, sessionId]);

  useEffect(() => {
    // Another session's files never show under this one, and a read still in
    // flight for the old session lands nowhere.
    seq.current++;
    setFiles((f) => (f.length === 0 ? f : EMPTY));
    if (!projectPath || !sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    void refresh();
    void listen("atlas:capture-changed", () => {
      if (!alive) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [projectPath, sessionId, refresh]);

  return files;
}
