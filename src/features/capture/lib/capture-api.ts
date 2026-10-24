// Typed wrappers for the capture reads a surface outside the capture popover
// needs. The popover itself still calls its commands inline; new callers come
// through here so no component invokes directly.

import { invoke } from "@tauri-apps/api/core";
import type { Binding, CaptureHealth } from "../types";

/** The project's capture binding, or `null` when capture was never set up. */
export async function captureBinding(projectPath: string): Promise<Binding | null> {
  return (await invoke<Binding | null>("capture_binding", { projectPath })) ?? null;
}

/** Why capture is degraded or stopped, if it is. `workspaceId` is the Atlas
 *  project id (the storage key is still called a workspace). An unmocked read
 *  in the browser harness resolves `null`. */
export async function captureHealth(
  projectPath: string,
  workspaceId: string | null,
): Promise<CaptureHealth | null> {
  return (
    (await invoke<CaptureHealth | null>("capture_health", { projectPath, workspaceId })) ?? null
  );
}
