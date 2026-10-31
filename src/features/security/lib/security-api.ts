// Every security-scan IPC call goes through here (ATL-985); no component
// invokes directly.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CheckpointSecurity, SessionSecurity, ShipOverview } from "../types";

/** The worker announces each stored scan on this channel. */
export const SECURITY_SCAN_CHANGED = "atlas:security-scan-changed";

/** Every scanned session in a Project, with its badge. */
export async function securityProjectSessions(projectPath: string): Promise<SessionSecurity[]> {
  return (
    (await invoke<SessionSecurity[] | null>("security_project_sessions", { projectPath })) ?? []
  );
}

/** A session's scanned checkpoints, for its Checkpoint cards. */
export async function securitySessionCheckpoints(
  projectPath: string,
  sessionId: string,
): Promise<CheckpointSecurity[]> {
  return (
    (await invoke<CheckpointSecurity[] | null>("security_session_checkpoints", {
      projectPath,
      sessionId,
    })) ?? []
  );
}

/** The branch's scanned checkpoints rolled up against its head. */
export async function securityShipOverview(
  projectPath: string,
  branch: string,
): Promise<ShipOverview | null> {
  return (
    (await invoke<ShipOverview | null>("security_ship_overview", { projectPath, branch })) ?? null
  );
}

/** One committed line, with any secret replaced, for "Show line". */
export async function securityFindingLine(
  projectPath: string,
  sha: string,
  path: string,
  line: number,
): Promise<string | null> {
  return (
    (await invoke<string | null>("security_finding_line", { projectPath, sha, path, line })) ?? null
  );
}

export async function securitySetNotUseful(
  projectPath: string,
  fingerprint: string,
  ruleId: string,
  notUseful: boolean,
): Promise<void> {
  await invoke("security_set_not_useful", { projectPath, fingerprint, ruleId, notUseful });
}

export function onSecurityScanChanged(handler: (projectPath: string) => void): Promise<UnlistenFn> {
  return listen<{ projectPath?: string } | null>(SECURITY_SCAN_CHANGED, (e) => {
    if (e.payload?.projectPath) handler(e.payload.projectPath);
  });
}
