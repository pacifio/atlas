import { logEvent } from "@/features/log/lib/log";
import { useLogStore } from "@/features/log/stores/log-store";
import { flushAll } from "@/features/workspaces/lib/flush-registry";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { resetGitSummariesForOrgSwitch } from "@/features/workspaces/stores/workspace-git-store";
import {
  useProjectStore,
  flushAppStateSave,
  scheduleAppStateSave,
} from "@/features/project/stores/project-store";
import { toast } from "sonner";
import { auth } from "@/features/auth/lib/auth-api";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useOrgStore } from "../stores/org-store";
import {
  busySessions,
  cancelBusySessions,
  useStopAgentsConfirmStore,
} from "@/features/workspaces/lib/stop-agents-confirm";

/** Minimum time the "Loading Organisation…" overlay stays up, so a fast switch
 *  doesn't flash it. */
const MIN_OVERLAY_MS = 450;

/** Guards re-entrant org switches while a teardown/reload is in flight. */
let switchingOrg = false;

/**
 * Switch the active Organisation. Tears down the OUTGOING org's entire mounted
 * workspace set (RAM freed, Rust watchers stopped), then brings the INCOMING
 * org's last-active (or most-recent) workspace online — the same cold-load path
 * as boot hydration — behind a full-app "Loading Organisation…" overlay.
 *
 * Mirrors the workspace `switchTo` contract: the active workspace is flushed
 * (awaited) before teardown so no unsaved KB/editor state is stranded.
 */
export async function switchOrg(id: string): Promise<void> {
  const orgActions = useOrgStore.getState().actions;
  const { activeOrganisationId, organisations } = useOrgStore.getState();

  if (id === activeOrganisationId) return;
  if (switchingOrg) return; // coalesce: ignore rapid double-clicks
  const target = organisations.find((o) => o.id === id);
  if (!target) return;

  switchingOrg = true;

  // Running agents die with the outgoing org's teardown — never silently.
  // Warn first (before the overlay, so the dialog is readable); "Go back"
  // aborts the switch entirely. Only the mounted (= outgoing) org's sessions
  // can be busy, so an unscoped count is the outgoing org's count.
  const busy = busySessions().length;
  if (busy > 0) {
    const ok = await useStopAgentsConfirmStore.getState().actions.ask({
      count: busy,
      actionLabel: "Switching organisations",
      confirmLabel: "Stop agents & switch",
    });
    if (!ok) {
      switchingOrg = false;
      return;
    }
  }

  orgActions.setSwitching(true);
  const startedAt = Date.now();

  try {
    const wsActions = useWorkspaceStore.getState().actions;
    const projectActions = useProjectStore.getState().actions;
    const outgoingActiveWs = useWorkspaceStore.getState().activeWorkspaceId;
    const outgoingPath = useProjectStore.getState().currentProject?.path ?? null;

    // 1) Remember the outgoing org's active workspace so switching back
    //    restores the user where they left off.
    if (activeOrganisationId) {
      orgActions.setActiveWorkspaceForOrg(activeOrganisationId, outgoingActiveWs);
    }

    // 2) Flush the active workspace's unsaved state (KB buffer, editor tabs)
    //    BEFORE teardown — awaited, exactly like `switchTo`. Then persist the
    //    workspace list + org active-ws pointers to disk.
    if (outgoingActiveWs) {
      await flushAll({ workspaceId: outgoingActiveWs, path: outgoingPath });
    }
    await flushAppStateSave();

    // 3) Cancel any still-running turns BEFORE dropping their sessions —
    //    `drop_session` alone never tells the adapter subprocess, which would
    //    keep editing files headless after the teardown.
    await cancelBusySessions();

    //    Tear down the whole outgoing hot set + clear the active workspace.
    //    Setting the project to null fires the App-level Rust lifecycle
    //    effects' null-branch (file index / git watch / recent files / mention
    //    cache all close), stopping the old org's watchers.
    wsActions.teardownForOrgSwitch();
    projectActions.setActiveProject(null);

    //    Drop the git-summary "already fetched" flags so the incoming org's
    //    sidebar rows re-validate instead of rendering cached-forever data.
    resetGitSummariesForOrgSwitch();

    // 4) Make the org swap authoritative. `setActiveOrganisation` also
    //    re-points analytics attribution (see `syncOrgTelemetry`), so events
    //    from here on are filed under the incoming org.
    orgActions.setActiveOrganisation(id);

    //    Re-scope the activity console the same way: drop the outgoing org's
    //    buffered entries and load the incoming org's pins. Without this the
    //    console keeps showing work from projects the teardown above just
    //    unmounted, which is the one surface in the app that would still be
    //    global after an org switch.
    void useLogStore.getState().actions.setOrg(id);

    // 5) Resolve the incoming org's target workspace and bring it online via
    //    the normal cold-load path. `switchTo` runs `loadProjectStores` + the
    //    App Rust-lifecycle effects for the new active workspace.
    const targetWsId = resolveTargetWorkspace(id, target.activeWorkspaceId);
    if (targetWsId) {
      await wsActions.switchTo(targetWsId);
    } else {
      // Empty org → Welcome screen (project already null).
      projectActions.setActiveProject(null);
    }

    scheduleAppStateSave();
    logEvent({
      source: "project",
      kind: "org-switch",
      summary: target.name,
      payload: { orgId: id, workspaceId: targetWsId ?? null },
    });
  } finally {
    // Keep the overlay up for a minimum time so it never flashes.
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, MIN_OVERLAY_MS - elapsed);
    setTimeout(() => {
      orgActions.setSwitching(false);
      switchingOrg = false;
    }, remaining);
  }
}

/**
 * Delete an organisation and every piece of app-state scoped to it (its
 * workspace/group references + recent chats for those projects). Refuses to
 * delete the only remaining org. If the target is the active org, switches to
 * another org FIRST (tearing down its workspace set behind the loading overlay)
 * so nothing dangles, then purges. Returns whether it deleted.
 *
 * Note: the user's actual project files + on-disk `.atlas/` data are NOT
 * removed — only Atlas's org-scoped tracking.
 */
export async function deleteOrgAndData(id: string): Promise<boolean> {
  const { organisations, activeOrganisationId } = useOrgStore.getState();
  if (organisations.length <= 1) return false;
  if (!organisations.some((o) => o.id === id)) return false;

  const target = organisations.find((o) => o.id === id);

  if (id === activeOrganisationId) {
    const next = organisations.find((o) => o.id !== id);
    if (!next) return false;
    await switchOrg(next.id); // teardown active set + load the next org
  }

  // Synced org → delete it server-side first so the add-only merge won't
  // re-add it. Best-effort: deleting is admin-only, so a member's call rejects
  // (403) — we still purge locally either way (the user's "delete locally
  // anyway"). A non-admin who stays a member on the server may see it return on
  // the next sync; that is the accepted tradeoff. Only signed-in, only if the
  // org was ever linked.
  if (target?.remoteId && useAuthStore.getState().snapshot.status === "signed-in") {
    try {
      await auth.deleteOrg(target.remoteId);
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Couldn't delete on the server.");
    }
  }

  // `id` is now guaranteed inactive (its workspaces are cold) → pure purge.
  const ok = useOrgStore.getState().actions.deleteOrg(id);
  if (ok) {
    logEvent({ source: "project", kind: "org-delete", summary: id });
  }
  return ok;
}

/**
 * Pick the workspace to open when entering an org: its remembered
 * `activeWorkspaceId` if it still exists, else the most-recently-active
 * workspace in that org, else none (empty org).
 */
function resolveTargetWorkspace(orgId: string, savedActiveWs: string | undefined): string | null {
  const { workspaces } = useWorkspaceStore.getState();
  const inOrg = workspaces.filter((w) => w.orgId === orgId);
  if (savedActiveWs && inOrg.some((w) => w.id === savedActiveWs)) {
    return savedActiveWs;
  }
  const mostRecent = [...inOrg].sort((a, b) =>
    (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
  )[0];
  return mostRecent?.id ?? null;
}
