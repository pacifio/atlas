// What the sidebar's rows, menus and chords do to a session.
//
// Every write goes through the lifecycle store (`session-lifecycle-store.ts`),
// which owns the invoke and toasts the backend's reason on a refusal; this
// module adds what the sidebar knows and the store does not — the list order a
// parked session moves along, the Undo on a settle, the tab to clear on a
// delete. Handlers read the list at call time through `SidebarListRef`, so
// the memoised rows can share one stable set of callbacks.

import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { useSessionLifecycleStore } from "@/features/chat/stores/session-lifecycle-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { checkoutState, switchBranchIfClean } from "@/features/git/lib/git-remote-api";
import { isGitError } from "@/features/git/lib/git-errors";
import { busySessions } from "@/features/projects/lib/stop-agents-confirm";
import { useAppStore } from "@/features/app/stores/app-store";
import { deleteThread, markSessionViewed, threadProjects } from "@/features/chat/lib/history-api";
import { isUnderRoot } from "@/features/chat/lib/session-roots";
import { confirmDeleteChat } from "@/features/chat/lib/confirm-delete-chat";
import { discardSessionDrawerFor } from "@/features/terminal/lib/session-drawer";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { openThread, tabShowingSession } from "@/features/chat/lib/open-thread";
import { AGENT_TYPE_BY_SIDEBAR } from "@/features/chat/lib/sidebar-agents";
import { pinOrderKeyForNewPin, planPinnedReorder } from "@/features/chat/lib/pin-order";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { SwitchableAgent } from "@/types/agent";
import { nextAfterParking, type SidebarSession } from "./sidebar-sessions";

/** How long the Undo on a settle, snooze or unpin stays up. */
const UNDO_MS = 5_000;

/** What the handlers read at call time: the list as shown, and the session
 *  the window is looking at. */
export interface SidebarListSnapshot {
  pinned: readonly SidebarSession[];
  active: readonly SidebarSession[];
  snoozed: readonly SidebarSession[];
  settled: readonly SidebarSession[];
  activeSessionId: string | null;
}

const lifecycle = () => useSessionLifecycleStore.getState().actions;

export function openSession(session: SidebarSession, intoTab?: string): void {
  void openThread(session, intoTab ? { intoTab } : {});
}

/** The open session was just parked (settled or snoozed): move its tab on to
 *  the next session in the list, or a fresh one when there is none. A row
 *  already open in another tab is skipped — opening it would focus that tab
 *  and leave this one showing the parked session. */
function advanceFrom(session: SidebarSession, list: SidebarListSnapshot): void {
  const tabId = tabShowingSession(session.sessionId);
  const rows = [...list.pinned, ...list.active].filter(
    (row) => row.threadId === session.threadId || !tabShowingSession(row.sessionId),
  );
  const next = nextAfterParking(rows, session.threadId);
  if (next && next.threadId !== session.threadId) openSession(next, tabId ?? undefined);
  else openNewAgentChat();
}

export async function settleSession(
  session: SidebarSession,
  list: SidebarListSnapshot,
): Promise<void> {
  const wasOpen = session.sessionId !== "" && session.sessionId === list.activeSessionId;
  if (!(await lifecycle().settle(session.threadId))) return;
  if (wasOpen) advanceFrom(session, list);
  toast("Session settled", {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => {
        void lifecycle()
          .unsettle(session.threadId)
          .then((ok) => {
            if (ok && wasOpen) openSession(session);
          });
      },
    },
  });
}

export function unsettleSession(session: SidebarSession): void {
  void lifecycle().unsettle(session.threadId);
}

export async function snoozeSession(
  session: SidebarSession,
  until: string,
  list: SidebarListSnapshot,
): Promise<void> {
  const wasOpen = session.sessionId !== "" && session.sessionId === list.activeSessionId;
  if (!(await lifecycle().snooze(session.threadId, until))) return;
  if (wasOpen) advanceFrom(session, list);
  toast("Session snoozed", {
    duration: UNDO_MS,
    // Not `wake`: a wake marks the session "Woke", and an undone snooze
    // never slept.
    action: { label: "Undo", onClick: () => void lifecycle().unsnooze(session.threadId) },
  });
}

export function pinSession(session: SidebarSession, list: SidebarListSnapshot): void {
  void lifecycle().pin(session.threadId, pinOrderKeyForNewPin(list.pinned[0]?.pinOrder ?? null));
}

export async function unpinSession(session: SidebarSession): Promise<void> {
  const key = session.pinOrder;
  if (!(await lifecycle().unpin(session.threadId))) return;
  toast("Session unpinned", {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => void lifecycle().pin(session.threadId, key ?? undefined),
    },
  });
}

/**
 * Drop a pinned session at `index` among the pinned (`orderedIds` is the
 * section's new order, with the moved session in it). Usually one write; a
 * section with a key that cannot be split is re-keyed whole.
 */
export async function reorderPinned(
  movedId: string,
  orderedIds: readonly string[],
  list: SidebarListSnapshot,
): Promise<void> {
  const keysById = new Map(list.pinned.map((row) => [row.threadId, row.pinOrder]));
  const plan = planPinnedReorder({ orderedIds, keysById, movedId });
  for (const { id, orderKey } of plan) {
    if (keysById.has(id)) await lifecycle().reorderPin(id, orderKey);
    else await lifecycle().pin(id, orderKey);
  }
}

export function markUnread(session: SidebarSession): void {
  void lifecycle().markUnread(session.threadId);
}

export function markRead(session: SidebarSession): void {
  if (!session.sessionId) return;
  markSessionViewed(session.sessionId).catch((err: unknown) =>
    toast.error(`Couldn't mark read: ${err instanceof Error ? err.message : String(err)}`),
  );
}

export function wakeSession(session: SidebarSession): void {
  void lifecycle().wake(session.threadId);
}

export async function renameSession(session: SidebarSession, title: string): Promise<void> {
  const next = title.trim();
  if (!next || next === session.title) return;
  await lifecycle().rename(session.threadId, next);
}

export async function deleteSession(session: SidebarSession): Promise<void> {
  if (!(await confirmDeleteChat(session.title))) return;
  try {
    // One call for every agent: Atlas's row always, the agent's copy only
    // when it advertised that it can forget it (ADR-0001).
    await deleteThread(session.threadId);
    // Its terminal drawer's shells end with it. (Settling keeps them: a
    // settled session comes back with Undo or a pin, shells and all.)
    discardSessionDrawerFor(session.sessionId);
    const tabId = tabShowingSession(session.sessionId);
    if (tabId) useChatStore.getState().actions.clearSession(tabId);
  } catch (err) {
    toast.error(
      `Couldn't delete session: ${
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err)
      }`,
    );
  }
}

/** Make `path` the active project, registering it in the active organisation
 *  when it is not open there. */
export async function activateProject(path: string): Promise<void> {
  if (useAppStore.getState().currentProject?.path === path) return;
  const store = useProjectStore.getState();
  const orgId = useOrgStore.getState().activeOrganisationId;
  const project = store.projects.find((p) => p.path === path && p.orgId === orgId);
  if (project) await store.actions.switchTo(project.id);
  else await store.actions.addProject(path);
}

/**
 * A fresh session on the branch this one ran on, with the same agent.
 *
 * A session in its own worktree starts the new one in that worktree, which is
 * already on the branch; nothing is switched. One in the project's checkout
 * switches the checkout only when nothing would be disturbed: never with
 * uncommitted changes in the working tree, and never under an agent that is
 * working there — in an Atlas tab or in a terminal. Otherwise it stops and
 * says why, offering to start on the branch the checkout is on instead. The
 * clean-tree check and the switch are one Rust command, so the tree cannot
 * go dirty between them.
 */
export async function newSessionOnBranch(session: SidebarSession): Promise<void> {
  await activateProject(session.projectPath);
  const agent = AGENT_TYPE_BY_SIDEBAR[session.agent] ?? (session.agent as SwitchableAgent);
  const start = () => openNewAgentChat(agent);
  const branch = session.branch;

  if (session.cwd !== session.projectPath) {
    useChatStore.getState().actions.setBindCwd(start(), session.cwd);
    return;
  }
  if (!branch) {
    start();
    return;
  }
  const checkout = await checkoutState(session.projectPath);
  if (!checkout || checkout.branch === branch) {
    start();
    return;
  }
  const leaveAlone = (blocker: string) =>
    toast.error(`Didn't switch to ${branch}`, {
      description: `The project is on ${checkout.branch} and ${blocker}, so Atlas left it alone.`,
      action: { label: `Start on ${checkout.branch}`, onClick: () => void start() },
    });
  if (checkout.dirty) {
    leaveAlone("it has uncommitted changes");
    return;
  }
  if (
    busySessions(session.projectPath).length > 0 ||
    (await agentWorkingElsewhere(session.projectPath))
  ) {
    leaveAlone("an agent is working in it");
    return;
  }
  try {
    await switchBranchIfClean(session.projectPath, branch);
  } catch (err) {
    if (isGitError(err) && err.code === "uncommitted-changes") {
      leaveAlone("it has uncommitted changes");
    } else {
      const description = isGitError(err) ? err.message : String(err);
      toast.error(`Couldn't switch to ${branch}`, { description });
    }
    return;
  }
  void useGitStore.getState().actions.refreshStatusNow(session.projectPath);
  start();
}

/** Whether a session running outside Atlas (a terminal agent) works in the
 *  checkout at `projectPath`, where a branch switch would move the tree
 *  under it. Read fresh rather than from the list on screen, which a scope
 *  or a search may have narrowed. A failed read counts as "yes": refusing a
 *  switch is the safe way to be wrong. */
export async function agentWorkingElsewhere(projectPath: string): Promise<boolean> {
  try {
    const groups = await threadProjects(projectPath);
    return groups.some((group) =>
      group.threads.some(
        (thread) => thread.liveElsewhere && isUnderRoot(thread.folderPaths[0] ?? "", projectPath),
      ),
    );
  } catch {
    return true;
  }
}

/** The project's own settings: the Settings screen, scoped to its folder. */
export function openProjectSettings(projectPath: string): void {
  useSettingsNav.getState().setScope(projectPath);
  openSettingsSection("general");
}

export async function copyToClipboard(value: string, what: string): Promise<void> {
  if (await copyText(value)) toast.success(`${what} copied`);
  else toast.error(`Couldn't copy the ${what.toLowerCase()}`);
}
