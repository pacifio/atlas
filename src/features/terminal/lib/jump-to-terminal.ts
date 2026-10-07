/**
 * Bring one terminal into view from anywhere — a notification, a toast, the
 * bell — switching project first if it lives in another one.
 *
 * The three pitfalls this exists to avoid:
 *  - `setActiveTab` on a tab id that is not in the current layout mirror falls
 *    back to `tabs[0]` (layout-store.ts:529-539). Switching project FIRST
 *    puts the tab in the mirror; if it is still absent the tab was closed and
 *    we say so rather than landing on an unrelated tab.
 *  - A terminal tab holds several terminals across panes; the tab is not the
 *    target, the terminal is.
 *  - Organisations are hard walls: the notification panel is org-filtered, so
 *    a cross-org jump can only come from a stale toast. Refuse rather than
 *    switch the user's whole organisation under them.
 */
import { toast } from "sonner";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { projectIdForTab } from "@/features/chat/lib/tab-project";
import { findTerminal, useTerminalStore } from "../stores/terminal-store";

export interface TerminalTarget {
  tabId: string;
  terminalId?: string;
  /** Known owner, when the caller has it; resolved otherwise. */
  projectId?: string;
}

export async function jumpToTerminal(t: TerminalTarget): Promise<boolean> {
  const ws = useProjectStore.getState();
  const owner = t.projectId ?? projectIdForTab(t.tabId);

  if (owner) {
    const ownerWs = ws.projects.find((w) => w.id === owner);
    const activeOrg = useOrgStore.getState().activeOrganisationId;
    if (ownerWs?.orgId && activeOrg && ownerWs.orgId !== activeOrg) {
      const org = useOrgStore.getState().organisations.find((o) => o.id === ownerWs.orgId);
      toast(`Switch to ${org?.name ?? "that organization"} to open this terminal`);
      return false;
    }
    if (owner !== ws.activeProjectId) {
      await ws.actions.switchTo(owner);
    }
  }

  const layout = useLayoutStore.getState();
  if (!layout.tabs.some((tab) => tab.id === t.tabId)) {
    toast("That terminal tab was closed");
    return false;
  }
  layout.actions.setActiveTab(t.tabId);

  const term = useTerminalStore.getState();
  if (t.terminalId) {
    const where = findTerminal(term.tabs, t.terminalId);
    if (where && where.tabId === t.tabId) {
      term.actions.setActiveTerminalInPane(t.tabId, where.paneId, t.terminalId);
      term.actions.setActivePane(t.tabId, where.paneId);
    }
  }
  // Consumed by the terminal once it is mounted, active and its surface is
  // ready — which may be a few frames from now after a project switch.
  term.actions.requestTerminalFocus(t.tabId);
  return true;
}
