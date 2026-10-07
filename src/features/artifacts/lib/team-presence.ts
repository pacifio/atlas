/**
 * Who is online, for the Timeline.
 *
 * Two live sources, unioned:
 *
 * - **The Workspace sockets' roster** (`presence` on `atlas:artifacts-cloud`):
 *   who is connected to a Project this machine is listening to — reading its
 *   Timeline, on the web or another desktop.
 * - **Team chat's online set** (`comms-store`): who holds a chat connection to
 *   the Organisation, which every signed-in Atlas does for as long as it runs.
 *
 * Either is "here right now"; neither alone covers a teammate who only has the
 * other open. Both carry bare user ids — no activity, no page — so the
 * `shareActivity` opt-out (which hides *what* somebody is doing, never *that*
 * they are here) has nothing on this wire to apply to.
 */

import { useMemo } from "react";
import { listen } from "@tauri-apps/api/event";

import type { OrgMember } from "@/features/auth/lib/auth-api";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";

import { useTeamPresenceStore } from "../stores/team-presence-store";

/** The window channel the cloud bridge emits on. */
export const ARTIFACTS_EVENT = "atlas:artifacts-cloud";

type PresenceFrame =
  | { kind: "presence"; projectId: string; online: string[] }
  | { kind: "revoked"; projectId: string }
  | { kind: string };

/**
 * Fold the cloud bridge's roster frames into the presence store, for the app's
 * lifetime. Returns the unlisten.
 */
export function startTeamPresenceListener(): () => void {
  const stop = listen<PresenceFrame>(ARTIFACTS_EVENT, (event) => {
    const frame = event.payload;
    const { actions } = useTeamPresenceStore.getState();
    if (frame.kind === "presence" && "online" in frame) {
      actions.setProject(frame.projectId, frame.online);
    } else if (frame.kind === "revoked" && "projectId" in frame) {
      actions.dropProject(frame.projectId);
    }
  });
  return () => safeUnlistenPromise(stop);
}

/** Every id any source says is online, deduplicated. */
export function onlineIds(
  byProject: Record<string, string[]>,
  chatOnline: readonly string[],
): Set<string> {
  const out = new Set<string>(chatOnline);
  for (const roster of Object.values(byProject)) {
    for (const id of roster) out.add(id);
  }
  return out;
}

/**
 * The teammates to show as online: members of the active Organisation, never
 * the viewer (you know you are here), sorted by name so the stack does not
 * reshuffle every time somebody reconnects.
 *
 * Ids the roster cannot name are left out rather than drawn as a blank face —
 * a guest, a former member, or a roster that has not loaded yet.
 */
export function onlineTeammates(online: ReadonlySet<string>, directory: OrgDirectory): OrgMember[] {
  const out: OrgMember[] = [];
  for (const id of online) {
    if (id === directory.currentUserId) continue;
    const member = directory.byId.get(id);
    if (member) out.push(member);
  }
  return out.sort((a, b) =>
    (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: "base" }),
  );
}

/**
 * The live online set. One subscription per caller — pass the set down rather
 * than calling this in every row.
 */
export function useOnlineIds(): ReadonlySet<string> {
  const byProject = useTeamPresenceStore.use.byProject();
  const chatOnline = useCommsStore.use.online();
  return useMemo(() => onlineIds(byProject, chatOnline), [byProject, chatOnline]);
}
