/** The IPC surface of organisation calls: the audit event, and the calls
 *  that cross to the window (answered through the UI actions' command). */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UiActionRequest } from "@/features/ui-actions/lib/types";
import type { OrgActionRecord } from "./types";

export function listenOrgAction(handler: (record: OrgActionRecord) => void): Promise<UnlistenFn> {
  return listen<OrgActionRecord>("atlas:org-action", (event) => handler(event.payload));
}

/** An organisation call for the window to perform (`WINDOW_TOOLS` in
 *  `src-tauri/src/commands/org_server/tools/mod.rs`): the UI action's wire,
 *  under its own event, answered by `respondUiAction`. */
export function listenOrgWindowAction(
  handler: (request: UiActionRequest) => void,
): Promise<UnlistenFn> {
  return listen<UiActionRequest>("atlas:org-window-action", (event) => handler(event.payload));
}
