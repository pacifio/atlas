// The terminal feature's IPC wrappers for the one-shot commands its components
// call. The PTY lifecycle (create, write, resize, ack, close) stays in
// `terminal-session.ts`, which owns the session and its channel.

import { invoke } from "@tauri-apps/api/core";

export interface RawGitStatus {
  is_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: unknown[];
}

export interface RawPathCompletion {
  name: string;
  is_dir: boolean;
}

export const gitStatusFresh = (path: string) => invoke<RawGitStatus>("git_status_fresh", { path });

export const resolvePath = (base: string, raw: string) =>
  invoke<string | null>("resolve_path", { base, raw });

export const listCommands = () => invoke<string[]>("terminal_list_commands");

export const pathComplete = (cwd: string, token: string) =>
  invoke<RawPathCompletion[]>("terminal_path_complete", { cwd, token });
