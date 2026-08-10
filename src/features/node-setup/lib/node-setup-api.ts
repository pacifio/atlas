// Thin TS wrapper around the `node_check` + `node_install` Tauri commands and
// their stream events. The ACP agents (`npx … claude-agent-acp`) need a working
// Node; this drives the auto-install via the bundled nvm when the machine has
// none / an incompatible one.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type NodeStatusKind = "ok" | "missing" | "incompatible";

export interface NodeStatus {
  status: NodeStatusKind;
  version: string | null;
  path: string | null;
  managed: boolean;
  minMajor: number;
}

export interface NodeInstallProgress {
  stream: "stdout" | "stderr";
  line: string;
}

export interface NodeInstallDone {
  success: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
}

export const nodeSetup = {
  check: () => invoke<NodeStatus>("node_check"),
  install: () => invoke<void>("node_install"),
};

export const listenNodeInstallProgress = (
  handler: (p: NodeInstallProgress) => void,
): Promise<UnlistenFn> =>
  listen<NodeInstallProgress>("atlas:node-install:progress", (e) => handler(e.payload));

export const listenNodeInstallDone = (handler: (p: NodeInstallDone) => void): Promise<UnlistenFn> =>
  listen<NodeInstallDone>("atlas:node-install:done", (e) => handler(e.payload));
