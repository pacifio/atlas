import { invoke } from "@tauri-apps/api/core";

/**
 * IPC seam for mirrored instructions (Rust `commands::instruction_sync`):
 * `CLAUDE.md` and `.claude/rules/` kept in a marked block of the project's
 * `AGENTS.md` while the `instructionSync` setting is on.
 *
 * Rust owns the setting check, so both calls are made whatever it says:
 * `start` tells Rust which project this window is working in (synced and
 * watched only while the setting is on, and the one acted on when it is
 * switched on), `stop` drops a closed project's watcher.
 *
 * `workspaceId` is the frozen IPC argument name for a project id.
 */
export const instructionSync = {
  start: (projectPath: string, projectId: string | null) =>
    invoke<void>("instruction_sync_start", { projectPath, workspaceId: projectId }),
  stop: (projectId: string) => invoke<void>("instruction_sync_stop", { workspaceId: projectId }),
};
