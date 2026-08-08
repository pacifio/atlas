// Thin TS wrapper around the `claude_status` + `claude_install` Tauri
// commands and their stream events. The auth login flow lives in
// `agents-api.ts` because the canonical source for "how do I log in" is
// the ACP adapter's `authMethods` (see `agents.listAuthMethods` /
// `agents.runAuthMethod`).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  auth_summary: string | null;
}

export interface ClaudeInstallProgress {
  stream: "stdout" | "stderr";
  line: string;
}

export interface ClaudeInstallDone {
  success: boolean;
  exit_code: number | null;
}

export const claudeSetup = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  install: () => invoke<void>("claude_install"),
};

export const listenClaudeInstallProgress = (
  handler: (p: ClaudeInstallProgress) => void,
): Promise<UnlistenFn> =>
  listen<ClaudeInstallProgress>("atlas:claude-install:progress", (e) => handler(e.payload));

export const listenClaudeInstallDone = (
  handler: (p: ClaudeInstallDone) => void,
): Promise<UnlistenFn> =>
  listen<ClaudeInstallDone>("atlas:claude-install:done", (e) => handler(e.payload));
