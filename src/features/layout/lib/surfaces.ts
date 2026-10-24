import type { ElementType } from "react";
import {
  Code,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Globe,
  MessagesSquare,
  ScrollText,
  Terminal,
} from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
import type { TabType } from "@/lib/constants";
import { useLayoutStore } from "../stores/layout-store";
import {
  currentRepoPath,
  openPullRequestListTab,
} from "@/features/pull-requests/lib/open-pull-request-list-tab";

/**
 * What a split column can open: the `+` menu and the "Open a surface" launcher
 * an empty column shows. One list, so the two
 * can never offer different things.
 *
 * `key` is a bare letter. It is the hint shown beside each row AND the key that
 * picks it — inside the open `+` menu, and anywhere while a focused column is
 * showing the launcher — so `⌘T` then `A` is a new agent (which opens in the
 * session column, like every session), `⌘T` then `T` a terminal. The hint and the match read the same field, so they cannot drift.
 *
 * Surfaces only (ADR-0024): Knowledge, Memory, Spaces and the other
 * destinations take the window, so they are not offered as a column's tab
 * (`tab-placement-contract.test.ts`). The rail and ⌘K reach them.
 */
export interface Surface {
  type: TabType;
  label: string;
  icon: ElementType;
  key: string;
}

export const SURFACES: readonly Surface[] = [
  { type: "chat", label: "Agent", icon: AtlasIcon, key: "A" },
  { type: "terminal", label: "Terminal", icon: Terminal, key: "T" },
  { type: "browser", label: "Browser", icon: Globe, key: "B" },
  { type: "editor", label: "New file", icon: Code, key: "N" },
  { type: "files", label: "Files", icon: FolderTree, key: "F" },
  { type: "source-control", label: "Source control", icon: GitBranch, key: "G" },
  { type: "pull-requests", label: "Pull requests", icon: GitPullRequest, key: "P" },
  { type: "team-chat", label: "Team chat", icon: MessagesSquare, key: "C" },
  { type: "log", label: "Log", icon: ScrollText, key: "L" },
];

/** Open `surface` as a new tab in split column `groupId`. */
export function openSurface(surface: Surface, groupId: string): void {
  // Source control and team chat are one per window, Files one per project;
  // `addTab` focuses the open one wherever it is.
  const { addTab } = useLayoutStore.getState().actions;
  const ts = Date.now();
  if (surface.type === "editor") {
    // The synthetic `untitled:<ts>` path starts the editor on an empty buffer
    // that falls into save-as on ⌘S (see `editor-panel.tsx`).
    addTab(
      {
        id: `editor-untitled-${ts}`,
        type: "editor",
        title: "Untitled",
        closable: true,
        dirty: false,
        data: { filePath: `untitled:${ts}` },
      },
      groupId,
    );
    return;
  }
  if (surface.type === "pull-requests") {
    // One list per checkout: the open project's.
    const repoPath = currentRepoPath();
    if (repoPath) openPullRequestListTab({ repoPath, groupId });
    return;
  }
  addTab(
    {
      id:
        surface.type === "source-control" ||
        surface.type === "team-chat" ||
        surface.type === "files"
          ? surface.type
          : `${surface.type}-${ts}`,
      type: surface.type,
      title: surface.type === "chat" ? "Agents" : surface.label,
      closable: true,
      dirty: false,
      data: {},
    },
    groupId,
  );
}

/**
 * The surface a key press picks: a bare letter, no modifiers, not mid-IME
 * composition. Shared by the `+` menu and the launcher.
 */
export function surfaceForKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): Surface | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  return SURFACES.find((s) => s.key.toLowerCase() === key) ?? null;
}

/** Event that opens split column `groupId`'s `+` menu — what `⌘T` sends once
 *  the window is already split. */
export const OPEN_SURFACE_MENU_EVENT = "atlas:open-surface-menu";
