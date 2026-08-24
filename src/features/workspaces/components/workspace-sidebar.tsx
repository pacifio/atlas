import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceGitStore, type GitSummary } from "../stores/workspace-git-store";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  FolderPlus,
  Plus,
  Folder,
  FolderOpen,
  X,
  ScrollText,
  Zap,
  Pin,
  PinOff,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
  Search,
  Trash2,
  Pencil,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceStore, type Workspace, type WorkspaceGroup } from "../stores/workspace-store";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { pickAndAddWorkspace } from "../lib/pick-workspace";
import { useRunningChatKeys } from "../lib/agent-activity";
import { openAgentSession } from "@/features/chat/lib/open-agent-session";
import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
import { AtlasLoader } from "@/components/atlas-loader";
import { AgentIcons } from "@/components/agent-icons";
import { useRecentChatsStore, type RecentChat } from "../stores/recent-chats-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { OrgSwitcher } from "@/features/organisations/components/org-switcher";
import { CaptureControl } from "@/features/capture/components/capture-control";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { AtlasIcon } from "@/components/atlas-icon";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { cn } from "@/lib/utils";
import { BranchLine, GitDot, NumStatPill } from "./git-summary";

// Slot heights (include the inter-row gap so the virtualizer spaces rows out);
// the visible card is a few px shorter than its slot.
const WS_H = 50;
const WS_CARD = 44;
const ROW_H = 27;
const ROW_CARD = 26;
const CHAT_H = 60;
const CHAT_CARD = 54;
const HEADER_H = 26;

// Memoised: every git-summary resolution replaces the summaries map and
// re-rendered EVERY visible row (each carrying a Radix dropdown tree). Props
// are memo-friendly by construction — `ws` objects are only remapped on
// workspace mutations, `summary` changes only for its own path, `groups` is
// store-stable — so a background summary refresh now re-renders one row.
const WorkspaceRow = memo(function WorkspaceRow({
  ws,
  active,
  summary,
  groups,
  indented,
}: {
  ws: Workspace;
  active: boolean;
  summary?: GitSummary;
  groups: WorkspaceGroup[];
  indented?: boolean;
}) {
  const {
    switchTo,
    closeWorkspace,
    pin,
    unpin,
    setGroup,
    addGroup,
    rename,
    beginRenameWorkspace,
    endRenameWorkspace,
  } = useWorkspaceStore.use.actions();
  // Inline-rename lives in the store (like group rename) so it survives the
  // virtualized row remounting. The name shown is the user-chosen workspace
  // label (defaults to the directory name) — renaming only relabels the row,
  // it never touches the on-disk path.
  const editing = useWorkspaceStore.use.editingWorkspaceId() === ws.id;
  const [nameDraft, setNameDraft] = useState(ws.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Seed the field AND focus it whenever we enter edit mode. `autoFocus` alone
  // is swallowed when the rename is triggered from the `…` menu: the input
  // mounts while Radix's dropdown is still tearing down its focus scope, which
  // eats the focus. Focusing explicitly on the next frame runs after that
  // teardown settles, so both the menu path and the double-click path land the
  // cursor in the field. (The group rename "just works" because its trigger is
  // a plain button, not inside a closing Radix layer.)
  useEffect(() => {
    if (!editing) return;
    setNameDraft(ws.name);
    const id = requestAnimationFrame(() => {
      const el = nameInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [editing, ws.name]);
  const commitRename = () => {
    const n = nameDraft.trim();
    if (n) rename(ws.id, n);
    endRenameWorkspace();
  };
  return (
    <div
      data-hint
      onClick={editing ? undefined : () => void switchTo(ws.id)}
      style={{ height: WS_CARD, paddingLeft: indented ? 16 : 6 }}
      className={cn(
        // `transform-gpu` keeps the row on a stable composited layer so the
        // `transition-colors` hover never promotes/demotes it mid-transition —
        // which was re-rasterizing the git dot at a fractional pixel and making
        // it visibly "jump" on hover.
        "group relative flex items-center gap-2 pr-2 rounded-md cursor-pointer transition-colors transform-gpu [backface-visibility:hidden]",
        active ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]",
      )}
      title={ws.path}
    >
      <GitDot summary={summary} />
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={nameInputRef}
            value={nameDraft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") endRenameWorkspace();
            }}
            className="block w-full pr-16 bg-transparent outline-none text-[12px] leading-tight font-medium text-[var(--text-primary)]"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              beginRenameWorkspace(ws.id);
            }}
            className={cn(
              "block truncate text-[12px] leading-tight pr-16",
              active ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]",
            )}
          >
            {ws.name}
          </span>
        )}
        <BranchLine summary={summary} className="mt-1 pr-12" />
      </div>

      {/* +/- git stat pill — absolute TOP-RIGHT. */}
      <div className="absolute top-1.5 right-2 pointer-events-none">
        <NumStatPill summary={summary} />
      </div>

      {/* Pin + more — absolute BOTTOM-RIGHT, on hover (pin stays if pinned). */}
      <div className="absolute bottom-1 right-1.5 flex items-center gap-0.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (ws.pinned) unpin(ws.id);
            else pin(ws.id);
          }}
          className={cn(
            "p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-tertiary)] transition-opacity cursor-pointer",
            ws.pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          title={ws.pinned ? "Unpin" : "Pin"}
        >
          {ws.pinned ? <PinOff size={11} /> : <Pin size={11} />}
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              className="p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity outline-none cursor-pointer"
              title="More"
            >
              <MoreHorizontal size={12} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              onClick={(e) => e.stopPropagation()}
              // On close Radix restores focus to the trigger button. When the
              // close is caused by selecting "Rename", that focus-return lands
              // AFTER the rename input has mounted+autofocused, blurring it
              // instantly → commitRename → edit mode exits. Suppressing the
              // close auto-focus lets the input keep focus.
              onCloseAutoFocus={(e) => e.preventDefault()}
              className="z-[var(--z-max)] min-w-[148px] rounded-md border border-[var(--border-default)] bg-black py-0.5 shadow-[var(--shadow-overlay)] text-[11px] text-[var(--text-secondary)]"
            >
              <DropdownMenu.Item
                onSelect={() => beginRenameWorkspace(ws.id)}
                className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
              >
                <Pencil size={11} /> Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => {
                  void navigator.clipboard
                    .writeText(ws.path)
                    .then(() => toast.success("Path copied"))
                    .catch(() => toast.error("Couldn't copy path"));
                }}
                className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
              >
                <Copy size={11} /> Copy path
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border-default)]" />
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="flex items-center justify-between px-2.5 h-6 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default">
                  Move to group <ChevronRight size={11} />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className="z-[var(--z-max)] min-w-[140px] rounded-md border border-[var(--border-default)] bg-black py-0.5 shadow-[var(--shadow-overlay)] text-[11px] text-[var(--text-secondary)]">
                    {groups.map((g) => (
                      <DropdownMenu.Item
                        key={g.id}
                        onSelect={() => setGroup(ws.id, g.id)}
                        className="px-2.5 h-6 flex items-center outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
                      >
                        {g.name}
                      </DropdownMenu.Item>
                    ))}
                    <DropdownMenu.Item
                      onSelect={() => {
                        const gid = addGroup("New Group");
                        setGroup(ws.id, gid);
                      }}
                      className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
                    >
                      <FolderPlus size={11} /> New group
                    </DropdownMenu.Item>
                    {ws.groupId && (
                      <>
                        <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border-default)]" />
                        <DropdownMenu.Item
                          onSelect={() => setGroup(ws.id, null)}
                          className="px-2.5 h-6 flex items-center outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
                        >
                          Remove from group
                        </DropdownMenu.Item>
                      </>
                    )}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
              <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border-default)]" />
              <DropdownMenu.Item
                onSelect={() => void closeWorkspace(ws.id)}
                className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--status-error,#f44)] cursor-default"
              >
                <X size={11} /> Remove from list
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
});

function GroupHeaderRow({
  group,
  collapsed,
  onToggle,
}: {
  group: WorkspaceGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { pinGroup, unpinGroup, removeGroup, renameGroup, beginRenameGroup, endRenameGroup } =
    useWorkspaceStore.use.actions();
  // Editing lives in the store (not local state) so it survives the virtualized
  // row remounting, and so a freshly-created group opens straight into rename.
  const editing = useWorkspaceStore.use.editingGroupId() === group.id;
  const [name, setName] = useState(group.name);
  // Seed the field each time we enter edit mode.
  useEffect(() => {
    if (editing) setName(group.name);
  }, [editing, group.name]);
  const commit = () => {
    const n = name.trim();
    if (n) renameGroup(group.id, n);
    endRenameGroup();
  };
  return (
    <div
      data-hint
      style={{ height: HEADER_H }}
      className="group/h flex items-center gap-1 pl-1 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)] transform-gpu [backface-visibility:hidden]"
      onClick={editing ? undefined : onToggle}
    >
      {collapsed ? (
        <ChevronRight size={12} className="text-[var(--text-tertiary)]" />
      ) : (
        <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
      )}
      <Folder size={11} className="text-[var(--text-tertiary)] shrink-0" />
      {editing ? (
        <input
          autoFocus
          value={name}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") endRenameGroup();
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
        />
      ) : (
        <span
          onDoubleClick={(e) => {
            e.stopPropagation();
            beginRenameGroup(group.id);
          }}
          className="flex-1 min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"
        >
          {group.name}
        </span>
      )}
      {!editing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            beginRenameGroup(group.id);
          }}
          className="p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-tertiary)] opacity-0 group-hover/h:opacity-100 transition-opacity cursor-pointer"
          title="Rename group"
        >
          <Pencil size={10} />
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (group.pinned) unpinGroup(group.id);
          else pinGroup(group.id);
        }}
        className={cn(
          "p-0.5 rounded hover:bg-[var(--bg-elevated)] transition-opacity cursor-pointer",
          group.pinned
            ? "opacity-100 text-[var(--accent-primary)]"
            : "opacity-0 group-hover/h:opacity-100 text-[var(--text-tertiary)]",
        )}
        title={group.pinned ? "Unpin group" : "Pin group"}
      >
        {group.pinned ? <PinOff size={10} /> : <Pin size={10} />}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          removeGroup(group.id);
        }}
        className="p-0.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-tertiary)] opacity-0 group-hover/h:opacity-100 transition-opacity cursor-pointer"
        title="Delete group"
      >
        <X size={10} />
      </button>
    </div>
  );
}

function SectionHeaderRow({
  label,
  collapsed,
  onToggle,
  action,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Optional hover-revealed action on the right (e.g. clear-all). */
  action?: { icon: React.ReactNode; title: string; onClick: () => void };
}) {
  return (
    <div
      data-hint
      onClick={onToggle}
      style={{ height: HEADER_H }}
      className="group/s w-full flex items-center gap-1 px-1.5 rounded-md hover:bg-[var(--bg-hover)] outline-none cursor-pointer"
    >
      {collapsed ? (
        <ChevronRight size={12} className="text-[var(--text-tertiary)]" />
      ) : (
        <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
      )}
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        {label}
      </span>
      {action && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
          title={action.title}
          className="ml-auto p-0.5 rounded text-[var(--text-tertiary)] opacity-0 group-hover/s:opacity-100 hover:bg-[var(--bg-elevated)] hover:text-[var(--status-error,#f44)] transition-opacity outline-none cursor-pointer"
        >
          {action.icon}
        </button>
      )}
    </div>
  );
}

function RecentProjectRow({
  name,
  path,
  onOpen,
}: {
  name: string;
  path: string;
  onOpen: () => void;
}) {
  return (
    <div
      data-hint
      onClick={onOpen}
      style={{ height: ROW_CARD, paddingLeft: 10 }}
      className="group flex items-center gap-2.5 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)]"
      title={path}
    >
      <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-[var(--text-secondary)]" />
      <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--text-secondary)]">
        {name}
      </span>
    </div>
  );
}

/** Compact relative time: "now" / "5m" / "3h" / "2d". */
function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ChatRow({
  chat,
  running,
  onOpen,
}: {
  chat: RecentChat;
  running: boolean;
  onOpen: () => void;
}) {
  // Cersei (the Atlas native agent) gets its own brand mark — falling through
  // to the Claude icon mislabeled Atlas chats in this panel.
  const AgentIcon =
    chat.agentType === "codex"
      ? AgentIcons.Codex
      : chat.agentType === "opencode"
        ? AgentIcons.OpenCode
        : chat.agentType === "cursor"
          ? AgentIcons.Cursor
          : chat.agentType === "kilo"
            ? AgentIcons.Kilo
            : AgentIcons.Claude;
  return (
    <div
      data-hint
      onClick={onOpen}
      style={{ height: CHAT_CARD, paddingLeft: 6 }}
      className="group relative flex items-start gap-2 pr-1.5 py-1.5 border-b border-[var(--border-subtle)] cursor-pointer hover:bg-[var(--bg-hover)] transform-gpu [backface-visibility:hidden]"
      title={chat.projectPath}
    >
      {running ? (
        <AtlasLoader size={11} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
      ) : chat.agentType === "cersei" ? (
        <AtlasIcon size={14} className="mt-0.5 shrink-0" />
      ) : (
        <AgentIcon className="mt-0.5 size-3.5 shrink-0" />
      )}
      <div
        className={cn(
          "min-w-0 flex-1 text-[12px] leading-[1.3] line-clamp-2 break-words",
          running ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
        )}
      >
        {stripInjectedContext(chat.title) || chat.projectName}
      </div>
      {/* Timestamp — bottom-left, aligned with the title start (past the icon). */}
      <span className="absolute bottom-1 left-7 text-[9px] font-mono text-[var(--text-tertiary)] tabular-nums">
        {relTime(chat.updatedAt)}
      </span>
      {/* Project badge — bottom-right. */}
      <span className="absolute bottom-1 right-1.5 max-w-[60%] truncate rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-1.5 py-px text-[9px] font-mono text-[var(--text-tertiary)]">
        {chat.projectName}
      </span>
    </div>
  );
}

type Row =
  | { kind: "section"; id: string; label: string; key: string }
  | { kind: "group"; group: WorkspaceGroup; count: number; key: string }
  | { kind: "ws"; ws: Workspace; indented: boolean; key: string }
  | { kind: "recent"; name: string; path: string; key: string }
  | { kind: "chat"; chat: RecentChat; key: string };

export function WorkspaceSidebar() {
  const allWorkspaces = useWorkspaceStore.use.workspaces();
  const allGroups = useWorkspaceStore.use.groups();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  // The sidebar shows only the ACTIVE org's workspaces/groups. A null `orgId`
  // (transient pre-migration state) is treated as belonging to the active org.
  const workspaces = useMemo(
    () => allWorkspaces.filter((w) => w.orgId === activeOrganisationId || w.orgId == null),
    [allWorkspaces, activeOrganisationId],
  );
  const groups = useMemo(
    () => allGroups.filter((g) => g.orgId === activeOrganisationId || g.orgId == null),
    [allGroups, activeOrganisationId],
  );
  const activeWorkspaceId = useWorkspaceStore.use.activeWorkspaceId();
  const optimisticActiveId = useWorkspaceStore.use.optimisticActiveId();
  // Highlight the clicked workspace INSTANTLY (optimistic), falling back to the
  // real active id once the switch settles.
  const displayActiveId = optimisticActiveId ?? activeWorkspaceId;
  const sidebarPinned = useWorkspaceStore.use.sidebarPinned();
  const { addWorkspace, toggleSidebarPinned } = useWorkspaceStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const recentProjects = useProjectStore.use.recentProjects();
  const { clearRecents } = useProjectStore.use.actions();
  const recentChats = useRecentChatsStore.use.items();
  const { remove: removeChat } = useRecentChatsStore.use.actions();
  const runningChatKeys = useRunningChatKeys();
  const isChatRunning = useCallback(
    (c: RecentChat) =>
      runningChatKeys.has(c.tabId) || (!!c.acpSessionId && runningChatKeys.has(c.acpSessionId)),
    [runningChatKeys],
  );
  const fullscreen = useFullscreen();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  // Pinned + Projects (STATIC registry order — clicking never reorders).
  const pinned = useMemo(() => workspaces.filter((w) => w.pinned), [workspaces]);
  const projects = useMemo(() => workspaces.filter((w) => !w.pinned), [workspaces]);
  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.order - b.order),
    [groups],
  );

  // Recent projects = picker recents NOT already in the registry. Excludes
  // projects open in ANY org (recents are global) so nothing double-lists.
  const openPaths = useMemo(() => new Set(allWorkspaces.map((w) => w.path)), [allWorkspaces]);
  const recents = useMemo(
    () => recentProjects.filter((r) => !openPaths.has(r.path)),
    [recentProjects, openPaths],
  );

  // Chats are recorded globally (no orgId), so scope the sidebar list to the
  // active org by keeping only chats whose project belongs to an active-org
  // workspace. `workspaces` is already org-filtered above; a project path maps
  // to exactly one workspace (addWorkspace dedupes by path), so this is
  // unambiguous. Chats for projects not open in this org are hidden.
  const orgWorkspacePaths = useMemo(() => new Set(workspaces.map((w) => w.path)), [workspaces]);
  const orgRecentChats = useMemo(
    () => recentChats.filter((c) => orgWorkspacePaths.has(c.projectPath)),
    [recentChats, orgWorkspacePaths],
  );

  // Section ids that currently exist (for collapse-all + the toggle button).
  const sectionIds = useMemo(() => {
    const ids: string[] = [];
    if (pinned.length) ids.push("sec:pinned");
    ids.push("sec:projects");
    if (recents.length) ids.push("sec:recent");
    if (orgRecentChats.length) ids.push("sec:chats");
    return ids;
  }, [pinned.length, recents.length, orgRecentChats.length]);

  // Flatten everything into one virtualized row list. Sections AND group
  // folders are collapsible; a collapsed section omits all its content rows.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (pinned.length) {
      out.push({
        kind: "section",
        id: "sec:pinned",
        label: "Pinned",
        key: "s:pinned",
      });
      if (!collapsed["sec:pinned"])
        for (const ws of pinned) out.push({ kind: "ws", ws, indented: false, key: ws.id });
    }
    out.push({
      kind: "section",
      id: "sec:projects",
      label: "Projects",
      key: "s:projects",
    });
    if (!collapsed["sec:projects"]) {
      const inGroup = (gid: string) => projects.filter((w) => w.groupId === gid);
      for (const g of sortedGroups) {
        const members = inGroup(g.id);
        out.push({
          kind: "group",
          group: g,
          count: members.length,
          key: `g:${g.id}`,
        });
        if (!collapsed[g.id])
          for (const ws of members) out.push({ kind: "ws", ws, indented: true, key: ws.id });
      }
      for (const ws of projects.filter((w) => !w.groupId))
        out.push({ kind: "ws", ws, indented: false, key: ws.id });
    }
    if (recents.length) {
      out.push({
        kind: "section",
        id: "sec:recent",
        label: "Recent",
        key: "s:recent",
      });
      if (!collapsed["sec:recent"])
        for (const r of recents)
          out.push({
            kind: "recent",
            name: r.name,
            path: r.path,
            key: `r:${r.path}`,
          });
    }
    if (orgRecentChats.length) {
      out.push({
        kind: "section",
        id: "sec:chats",
        label: "Chats",
        key: "s:chats",
      });
      // Active (live-running) chats float to the top of the stack; the rest keep
      // their most-recent-first order. Capacity (15) is enforced by the store.
      const ordered = [
        ...orgRecentChats.filter(isChatRunning),
        ...orgRecentChats.filter((c) => !isChatRunning(c)),
      ];
      if (!collapsed["sec:chats"])
        for (const c of ordered) out.push({ kind: "chat", chat: c, key: `c:${c.tabId}` });
    }
    return out;
  }, [pinned, projects, sortedGroups, collapsed, recents, orgRecentChats, isChatRunning]);

  // Collapse-all / expand-all: collapses every section + group, or expands all.
  const allCollapsibleIds = useMemo(
    () => [...sectionIds, ...groups.map((g) => g.id)],
    [sectionIds, groups],
  );
  const allCollapsed =
    allCollapsibleIds.length > 0 && allCollapsibleIds.every((id) => collapsed[id]);
  const toggleAll = () => {
    if (allCollapsed) setCollapsed({});
    else setCollapsed(Object.fromEntries(allCollapsibleIds.map((id) => [id, true])));
  };

  // ── Git summaries: cached at module scope (`workspace-git-store`) so opening
  // / closing the switcher renders instantly from cache and NEVER recalculates.
  // First sight fetches; a global git-changed listener silently refreshes in the
  // background. We only `ensure` the currently-VISIBLE rows (never the whole
  // 100s-long list).
  const summaries = useWorkspaceGitStore.use.summaries();
  const { ensure: ensureSummary } = useWorkspaceGitStore.use.actions();

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const k = rows[i]?.kind;
      if (k === "ws") return WS_H;
      if (k === "chat") return CHAT_H;
      if (k === "recent") return ROW_H;
      return HEADER_H + 2; // section / group headers
    },
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  // Fetch git summaries for the visible workspace rows.
  const items = virtualizer.getVirtualItems();
  const visiblePaths = items
    .map((v) => {
      const r = rows[v.index];
      return r?.kind === "ws" ? r.ws.path : null;
    })
    .filter(Boolean)
    .join("|");
  useEffect(() => {
    for (const p of visiblePaths.split("|")) if (p) ensureSummary(p);
  }, [visiblePaths, ensureSummary]);

  const openChat = useCallback(
    async (chat: RecentChat) => {
      // 1. Focus the chat's project workspace (register it if new). Prefer
      //    the ACTIVE org's row — the same path can be a workspace in several
      //    orgs, and switching to another org's twin would silently jump the
      //    user across organisations. addWorkspace registers an org-scoped
      //    row when this org has none.
      const st = useWorkspaceStore.getState();
      const orgId = useOrgStore.getState().activeOrganisationId;
      const twins = st.workspaces.filter((w) => w.path === chat.projectPath);
      const ws = twins.find((w) => w.orgId === orgId || w.orgId == null) ?? twins[0];
      if (ws) await st.actions.switchTo(ws.id);
      else await addWorkspace(chat.projectPath);
      // 2. Open THIS session (by acp session id — not the tab id, which is reused
      //    across many sessions). openAgentSession focuses it if already open,
      //    else loads it into the agent chat.
      await openAgentSession({
        acpSessionId: chat.acpSessionId,
        title: chat.title,
        cwd: chat.projectPath,
        agentType: chat.agentType,
      });
    },
    [addWorkspace],
  );

  const openTabSingleton = (type: "mission-control" | "log" | "settings", title: string) =>
    addTab({
      id: type === "mission-control" ? "mission-control" : type,
      type,
      title,
      closable: true,
      dirty: false,
      data: {},
    });

  return (
    <aside
      // Transparent — the frosted glass (bg + `backdrop-blur-2xl`) lives on the
      // animated OVERLAY wrapper in app-layout.tsx, not here. Putting the blur
      // on this child would break it: the wrapper's opacity/transform isolates
      // its own layer, leaving a descendant's backdrop-filter nothing to sample.
      className="flex flex-col h-screen w-[244px] shrink-0 bg-transparent"
      data-tauri-drag-region
    >
      {/* Top bar: aligned to the titlebar height (h-[30px] + border-b) so the
       *  line under the traffic lights matches the rest of the title bar.
       *  Buttons sit right to dodge the traffic lights — but in fullscreen the
       *  lights are gone, so reclaim the left edge. */}
      <div
        className={cn(
          "h-[30px] shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border-default)]",
          fullscreen ? "justify-start" : "justify-end",
        )}
        data-tauri-drag-region
      >
        <button
          onClick={toggleSidebarPinned}
          className={cn(
            "p-1 rounded-full outline-none transition-colors hover:bg-[var(--bg-hover)] cursor-pointer",
            sidebarPinned
              ? "text-[var(--accent-primary)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
          )}
          title={
            sidebarPinned ? "Unpin sidebar (float as overlay)" : "Pin sidebar (dock into layout)"
          }
        >
          {sidebarPinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button
          onClick={toggleAll}
          className="p-1 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] outline-none cursor-pointer"
          title={allCollapsed ? "Expand all" : "Collapse all"}
        >
          {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
        </button>
        <AddProjectMenu />
      </div>

      {/* Organisation switcher — the top-level tenant picker. Sits below the
       *  titlebar drag zone so it clears the traffic lights. */}
      <OrgSwitcher />

      {/* Sessions captured in the current Workspace. Sits above the other
       *  header actions because it is Workspace-scoped, unlike Console/Logs —
       *  and carries the recording dot, so whether work is being recorded is
       *  answerable without opening anything. */}
      <CaptureControl />

      {/* Header actions. Console and Settings moved up into the org row as
       *  icon buttons; what stays here is the workspace-scoped set. */}
      <div className="px-1.5 pb-1 shrink-0 space-y-0.5">
        <HeaderButton
          icon={<ScrollText size={13} />}
          label="See Logs"
          onClick={() => openTabSingleton("log", "Log")}
        />
        <HeaderButton
          icon={<Zap size={13} />}
          label="Skills"
          onClick={() => openSettingsSection("skills")}
        />
      </div>

      {/* Separates the fixed header actions from the scrolling project list. */}
      <div className="mx-1.5 mb-1 shrink-0 border-t border-[var(--border-default)]" />

      {/* Virtualized list. */}
      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto hide-scrollbar px-1.5 pb-2">
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-[var(--text-tertiary)]">No projects yet.</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              return (
                <div
                  key={row.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  {row.kind === "section" ? (
                    <SectionHeaderRow
                      label={row.label}
                      collapsed={!!collapsed[row.id]}
                      onToggle={() => toggle(row.id)}
                      action={
                        row.id === "sec:recent"
                          ? {
                              icon: <Trash2 size={11} />,
                              title: "Clear recent projects",
                              onClick: () => clearRecents(),
                            }
                          : row.id === "sec:chats"
                            ? {
                                icon: <Trash2 size={11} />,
                                title: "Clear chats",
                                onClick: () => orgRecentChats.forEach((c) => removeChat(c.tabId)),
                              }
                            : undefined
                      }
                    />
                  ) : row.kind === "group" ? (
                    <GroupHeaderRow
                      group={row.group}
                      collapsed={!!collapsed[row.group.id]}
                      onToggle={() => toggle(row.group.id)}
                    />
                  ) : row.kind === "ws" ? (
                    <WorkspaceRow
                      ws={row.ws}
                      active={row.ws.id === displayActiveId}
                      summary={summaries[row.ws.path]}
                      groups={groups}
                      indented={row.indented}
                    />
                  ) : row.kind === "recent" ? (
                    <RecentProjectRow
                      name={row.name}
                      path={row.path}
                      onOpen={() => void addWorkspace(row.path)}
                    />
                  ) : (
                    <ChatRow
                      chat={row.chat}
                      running={isChatRunning(row.chat)}
                      onOpen={() => void openChat(row.chat)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function HeaderButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
    >
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      {label}
    </button>
  );
}

/** The "+" dropdown that replaced the old titlebar project picker: Open Folder
 *  + searchable Recent projects, adding the chosen project to the sidebar. */
function AddProjectMenu() {
  const { addWorkspace } = useWorkspaceStore.use.actions();
  const recentProjects = useProjectStore.use.recentProjects();
  const { clearRecents } = useProjectStore.use.actions();
  const [query, setQuery] = useState("");
  const filtered = recentProjects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <DropdownMenu.Root
      onOpenChange={(o) => {
        if (!o) setQuery("");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center justify-center h-6 w-6 rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors cursor-pointer"
          title="Add project"
        >
          <Plus size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Compact menu primitive — mirrors the source-control "filter files"
         *  dropdown: 26px rows, px-3 on both sides, border-b search header. */}
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[var(--z-max)] w-[280px] max-h-[360px] rounded-lg border border-[var(--border-default)] bg-[#000] shadow-xl text-[var(--text-secondary)] flex flex-col overflow-hidden"
        >
          <DropdownMenu.Item
            onSelect={() => void pickAndAddWorkspace()}
            className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default shrink-0"
          >
            <FolderOpen size={13} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="flex-1 text-left">Open Folder…</span>
          </DropdownMenu.Item>
          {recentProjects.length > 0 && (
            <>
              <div
                className="flex items-center gap-1.5 px-3 h-[30px] border-y border-[var(--border-default)] shrink-0"
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects…"
                  className="flex-1 bg-transparent outline-none text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
              </div>
              <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wide text-[var(--text-tertiary)] shrink-0">
                Recent
              </div>
              <div className="overflow-y-auto py-1 hide-scrollbar">
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-[10px] text-[var(--text-tertiary)] text-center">
                    No matches
                  </div>
                ) : (
                  filtered.map((p) => (
                    <DropdownMenu.Item
                      key={p.path}
                      onSelect={() => void addWorkspace(p.path)}
                      className="w-full flex items-center gap-2 px-3 h-[26px] text-[11px] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
                    >
                      <Folder size={12} className="text-[var(--text-tertiary)] shrink-0" />
                      <span className="truncate font-mono text-left flex-1">{p.name}</span>
                    </DropdownMenu.Item>
                  ))
                )}
              </div>
              <DropdownMenu.Item
                onSelect={() => clearRecents()}
                className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] outline-none border-t border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--status-error,#f44)] cursor-pointer shrink-0"
              >
                <Trash2 size={12} className="shrink-0" />
                <span className="flex-1 text-left">Clear recent projects</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
