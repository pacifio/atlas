import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";

/**
 * Tab ↔ workspace resolution. Tab ids are unique across workspaces, so a tab
 * has exactly one owner: the active workspace if it's in the live layout
 * mirror, else whichever committed `viewsByWs` entry contains it, else (for a
 * bound chat) the workspace whose path matches the session's cwd.
 */
export function workspaceIdForTab(tabId: string): string | null {
  const layout = useLayoutStore.getState();
  const ws = useWorkspaceStore.getState();
  if (layout.tabs.some((t) => t.id === tabId)) return ws.activeWorkspaceId;
  for (const [wsId, view] of Object.entries(layout.viewsByWs)) {
    if (view.tabs.some((t) => t.id === tabId)) return wsId;
  }
  const path = useChatStore.getState().sessions[tabId]?.workingDirectory;
  if (path) {
    // Paths are unique per ORG, not globally (the same folder can be a
    // workspace in several organisations). Prefer the active workspace when
    // it matches, so a cross-org twin never claims the active org's tab.
    const active = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    if (active?.path === path) return active.id;
    return ws.workspaces.find((w) => w.path === path)?.id ?? null;
  }
  return null;
}

/** The project root a tab lives in — what a chat bind must use as cwd. The
 *  global `currentProject` is the ACTIVE workspace's, which is wrong for a
 *  background workspace's still-mounted chat panel. */
export function workspacePathForTab(tabId: string): string | null {
  const id = workspaceIdForTab(tabId);
  if (!id) return null;
  return useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.path ?? null;
}

/**
 * Bring a chat tab into view from anywhere: switch to its workspace first if
 * needed (a bare `setActiveTab` on a foreign tab id falls back to `tabs[0]` of
 * the CURRENT workspace), then activate + focus it.
 */
export async function jumpToSession(tabId: string): Promise<void> {
  const ws = useWorkspaceStore.getState();
  const ownerId = workspaceIdForTab(tabId);
  if (ownerId && ownerId !== ws.activeWorkspaceId) {
    await ws.actions.switchTo(ownerId);
  }
  useLayoutStore.getState().actions.setActiveTab(tabId);
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
}
