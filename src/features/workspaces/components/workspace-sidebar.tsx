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
  MessagesSquare,
  GitBranch,
  TerminalSquare,
  Users,
  HelpCircle,
  MessageCircle,
  Sparkles,
  BookOpen,
  Ellipsis,
} from "lucide-react";
import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWorkspaceStore, type Workspace, type WorkspaceGroup } from "../stores/workspace-store";
import { pickAndAddWorkspace } from "../lib/pick-workspace";
import { useRunningChatKeys } from "../lib/agent-activity";
import { openAgentSession, openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
import { AtlasLoader } from "@/components/atlas-loader";
import { AgentIcons } from "@/components/agent-icons";
import { useRecentChatsStore, type RecentChat } from "../stores/recent-chats-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useActiveOrgWorkspaces, useActiveOrgGroups } from "../lib/org-scope";
import { OrgSwitcher } from "@/features/organisations/components/org-switcher";
import { MembersModal } from "@/features/organisations/components/members-modal";
import { CaptureControl } from "@/features/capture/components/capture-control";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { AtlasIcon } from "@/components/atlas-icon";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { cn } from "@/lib/utils";
import { GitDot, NumStatPill } from "./git-summary";

// Slot heights (include the inter-row gap so the virtualizer spaces rows out);
// the visible card is a few px shorter than its slot.
//
// Rows are quiet, not dense. Chats and recents are one 28px line; a project
// keeps two (name, then branch or "no source control") because the second
// line is what tells `api` from `api-v2` — folding the branch onto the name
// line made the two collide on any long name. Section headers carry the
// breathing room (a gap above), not the rows.
const WS_H = 46;
const WS_CARD = 42;
const ROW_H = 30;
const ROW_CARD = 28;
const CHAT_H = 46;
const CHAT_CARD = 42;
const HEADER_H = 28;
/** Section header slot: the header plus the gap that separates sections. */
const SECTION_H = HEADER_H + 10;

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
      style={{ height: WS_CARD, paddingLeft: indented ? 22 : 8 }}
      className={cn(
        // `transform-gpu` keeps the row on a stable composited layer so the
        // `transition-colors` hover never promotes/demotes it mid-transition —
        // which was re-rasterizing the git dot at a fractional pixel and making
        // it visibly "jump" on hover.
        "group relative flex items-center gap-2.5 pr-1.5 rounded-md cursor-pointer transition-colors transform-gpu [backface-visibility:hidden]",
        active ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]",
      )}
      title={ws.path}
    >
      <GitDot summary={summary} className="size-1.5" />
      {/* `pr-14` clears the right slot (pill at rest, actions on hover) on both
          lines, so neither can run under it. */}
      <div className="flex-1 min-w-0 pr-14">
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
            className="block w-full bg-transparent outline-none text-[12px] leading-tight text-[var(--text-primary)]"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              beginRenameWorkspace(ws.id);
            }}
            className={cn(
              "block truncate text-[12px] leading-tight",
              active
                ? "text-[var(--text-primary)] font-medium"
                : "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]",
            )}
          >
            {ws.name}
          </span>
        )}
        <span className="mt-0.5 block truncate text-[10px] leading-tight text-[var(--text-tertiary)]">
          {summary?.isRepo ? summary.branch || "—" : "no source control"}
        </span>
      </div>

      {/* Right slot: the +N/−M at rest, the row actions on hover. Both live in
          one full-height, GPU-promoted box and swap with NO transition: an
          opacity tween on an unpromoted child re-rasterises it mid-fade and the
          icons visibly wobble (the same lesson as the git dot above). */}
      <span className="absolute inset-y-0 right-1.5 flex items-center transform-gpu [backface-visibility:hidden]">
        <span className="group-hover:opacity-0">
          <NumStatPill summary={summary} />
        </span>
        <span className="absolute inset-y-0 right-0 flex items-center gap-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (ws.pinned) unpin(ws.id);
              else pin(ws.id);
            }}
            className={cn(
              "flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] cursor-pointer",
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
                className="flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] outline-none cursor-pointer"
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
        </span>
      </span>
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
      className="group/h flex items-center gap-2 pl-2 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)] transform-gpu [backface-visibility:hidden]"
      onClick={editing ? undefined : onToggle}
    >
      {/* Icon and label are sized together: a 12px folder under an 11px label,
          the same pairing the rows below use. A 12px label over an 11px icon
          read as a heading that had lost its glyph. */}
      {collapsed ? (
        <Folder size={12} className="text-[var(--text-tertiary)] shrink-0" />
      ) : (
        <FolderOpen size={12} className="text-[var(--text-tertiary)] shrink-0" />
      )}
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
          className="min-w-0 flex-1 bg-transparent outline-none text-[11px] leading-none text-[var(--text-primary)]"
        />
      ) : (
        <span
          onDoubleClick={(e) => {
            e.stopPropagation();
            beginRenameGroup(group.id);
          }}
          className="min-w-0 flex-1 truncate text-[11px] leading-none text-[var(--text-secondary)] group-hover/h:text-[var(--text-primary)]"
        >
          {group.name}
        </span>
      )}

      {/* Actions + disclosure in ONE promoted box with NO opacity transition:
          tweening opacity on an unpromoted icon makes WebKit re-rasterise it
          mid-fade, which is the hover wobble (same lesson as the git dot). */}
      <span className="ml-auto flex shrink-0 items-center gap-0.5 transform-gpu [backface-visibility:hidden]">
        {!editing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              beginRenameGroup(group.id);
            }}
            className="flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] opacity-0 hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] group-hover/h:opacity-100 cursor-pointer"
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
            "flex size-5 items-center justify-center rounded hover:bg-[var(--bg-elevated)] cursor-pointer",
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
          className="flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] opacity-0 hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] group-hover/h:opacity-100 cursor-pointer"
          title="Delete group"
        >
          <X size={10} />
        </button>
        {!editing && (
          <ChevronDown
            size={10}
            className={cn(
              "shrink-0 text-[var(--text-tertiary)] transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        )}
      </span>
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
    // Sentence case, bold, in the secondary weight, with a small disclosure
    // AFTER the label. The slot is taller than the row: the extra is the gap
    // between sections.
    <div style={{ height: SECTION_H, paddingTop: SECTION_H - HEADER_H }}>
      <div
        data-hint
        onClick={onToggle}
        style={{ height: HEADER_H }}
        className="group/s flex w-full items-center gap-1 rounded-md px-2 outline-none cursor-pointer hover:bg-[var(--bg-hover)]"
      >
        <span className="text-[11px] font-semibold leading-none text-[var(--text-secondary)] group-hover/s:text-[var(--text-primary)]">
          {label}
        </span>
        {/* Promoted, and NO opacity tween on the action: fading an unpromoted
            icon makes WebKit re-rasterise it mid-fade, which is the hover
            wobble (same lesson as the git dot). */}
        <span className="flex items-center transform-gpu [backface-visibility:hidden]">
          <ChevronDown
            size={10}
            className={cn(
              "text-[var(--text-tertiary)] transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        </span>
        {action && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
            title={action.title}
            className="ml-auto flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] opacity-0 group-hover/s:opacity-100 hover:bg-[var(--bg-elevated)] hover:text-[var(--status-error,#f44)] outline-none cursor-pointer transform-gpu [backface-visibility:hidden]"
          >
            {action.icon}
          </button>
        )}
      </div>
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
      style={{ height: ROW_CARD, paddingLeft: 8 }}
      className="group flex items-center gap-2.5 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)]"
      title={path}
    >
      <Folder size={13} className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="flex-1 min-w-0 truncate text-[12px] leading-none text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
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
      style={{ height: CHAT_CARD, paddingLeft: 8 }}
      className="group relative flex items-start gap-2.5 pr-2 pt-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)] transform-gpu [backface-visibility:hidden]"
      title={`${chat.projectName} — ${chat.projectPath}`}
    >
      {running ? (
        <AtlasLoader size={12} className="shrink-0 text-[var(--accent-primary)]" />
      ) : chat.agentType === "cersei" ? (
        <AtlasIcon size={13} className="shrink-0" />
      ) : (
        <AgentIcon className="size-[13px] shrink-0 opacity-80" />
      )}
      {/* Two lines, like a project row: the chat list spans every project in
          the org, so a title alone cannot say which one a chat belongs to —
          and the titles are the user's own words, which rarely name it. The
          project goes on the second line, where the branch sits one section
          up. `pr-9` keeps both lines clear of the timestamp. */}
      <div className="min-w-0 flex-1 pr-9">
        <span
          className={cn(
            "block truncate text-[12px] leading-tight",
            running
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]",
          )}
        >
          {stripInjectedContext(chat.title) || chat.projectName}
        </span>
        <span className="mt-0.5 block truncate text-[10px] leading-tight text-[var(--text-tertiary)]">
          {chat.projectName}
        </span>
      </div>
      <span className="absolute right-2 top-2 shrink-0 text-[10px] leading-none tabular-nums text-[var(--text-tertiary)]">
        {relTime(chat.updatedAt)}
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
  // The sidebar shows only the ACTIVE org's workspaces/groups (strict filter —
  // see org-scope.ts for why there is no null-orgId fallback).
  const workspaces = useActiveOrgWorkspaces();
  const groups = useActiveOrgGroups();
  const activeWorkspaceId = useWorkspaceStore.use.activeWorkspaceId();
  const optimisticActiveId = useWorkspaceStore.use.optimisticActiveId();
  // Highlight the clicked workspace INSTANTLY (optimistic), falling back to the
  // real active id once the switch settles.
  const displayActiveId = optimisticActiveId ?? activeWorkspaceId;
  const sidebarPinned = useWorkspaceStore.use.sidebarPinned();
  const { addWorkspace, toggleSidebarPinned } = useWorkspaceStore.use.actions();
  const { addTab, toggleRightPanelMode } = useLayoutStore.use.actions();
  // Which occupant the right slot shows, or null when closed — drives the
  // active state of the Chat / Source control items.
  const rightMode = useLayoutStore((s) => (s.rightPanel.visible ? s.rightPanel.mode : null));
  // Source control needs a project (app-layout hides the slot without one), so
  // the item says so instead of toggling a panel that never appears.
  const hasProject = useProjectStore((s) => !!s.currentProject);
  // Team chat and the member roster are SERVER features: every route names a
  // server org id, so a local-only organisation has nothing to talk to. Same
  // test comms-panel.tsx applies before it connects.
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const activeOrg = organisations.find((o) => o.id === activeOrganisationId) ?? null;
  const orgSynced = !!(activeOrg?.syncEnabled && activeOrg?.remoteId);
  const [membersOpen, setMembersOpen] = useState(false);
  const newTabHint = useActionShortcut("nav.newTabPalette")?.label;
  // Mirrors `panels.knowledge` in App.tsx: one Knowledge tab per split column,
  // focused if it already exists.
  const openKnowledge = useCallback(() => {
    const st = useLayoutStore.getState();
    const g = st.focusedGroupId;
    const existing = st.tabs.find((t) => (t.groupId ?? "main") === g && t.type === "knowledge");
    if (existing) {
      st.actions.setActiveTab(existing.id);
      return;
    }
    st.actions.addTab({
      id: `knowledge-${Date.now()}`,
      type: "knowledge",
      title: "Knowledge",
      closable: true,
      dirty: false,
      data: {},
    });
  }, []);
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
  // The virtualized rows no longer start at the scroller's top — the nav sits
  // above them inside the same scroll element. `scrollMargin` is how far down
  // they begin; without it the virtualizer maps `scrollTop` straight onto row
  // offsets and materialises the wrong window (rows blank out early at the top
  // and arrive late at the bottom). Re-measured whenever the nav changes
  // height, which it does every time the Modules group collapses.
  const navRef = useRef<HTMLElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const measure = () => setScrollMargin(el.offsetTop + el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const virtualizer = useVirtualizer({
    count: rows.length,
    scrollMargin,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const k = rows[i]?.kind;
      if (k === "ws") return WS_H;
      if (k === "chat") return CHAT_H;
      if (k === "recent") return ROW_H;
      if (k === "section") return SECTION_H;
      return HEADER_H + 2; // group headers
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
      const ws = st.workspaces.find((w) => w.path === chat.projectPath && w.orgId === orgId);
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

  return (
    <aside
      // Transparent — the surface (gradient + blur) lives on the wrapper in
      // app-layout.tsx, not here. Putting the blur on this child would break
      // it: the wrapper's opacity/transform isolates its own layer, leaving a
      // descendant's backdrop-filter nothing to sample.
      className="flex flex-col h-screen w-[244px] shrink-0 bg-transparent"
      data-tauri-drag-region
    >
      {/* Titlebar band: the traffic lights live here, so the rail's own
       *  controls keep right (left in fullscreen, where the lights are gone).
       *  No rule under it — the org row below is the visual top of the rail. */}
      <div
        className={cn(
          "h-[30px] shrink-0 flex items-center gap-0.5 px-2",
          fullscreen ? "justify-start" : "justify-end",
        )}
        data-tauri-drag-region
      >
        <RailIconButton
          onClick={toggleSidebarPinned}
          active={sidebarPinned}
          title={
            sidebarPinned ? "Unpin sidebar (float as overlay)" : "Pin sidebar (dock into layout)"
          }
        >
          {sidebarPinned ? <PinOff size={12} /> : <Pin size={12} />}
        </RailIconButton>
        <RailIconButton onClick={toggleAll} title={allCollapsed ? "Expand all" : "Collapse all"}>
          {allCollapsed ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
        </RailIconButton>
        <AddProjectMenu />
      </div>

      {/* Organisation switcher — the top-level tenant picker. */}
      <OrgSwitcher />

      {/* Virtualized list. */}
      {/* The rail's interface card — the same recipe as team chat's
          `CommsSurface`: a near-black rounded surface floating on the panel's
          gradient, inset on the sides and bottom, its edge carried by a
          hairline ring with a soft shadow behind it. No blur and no transform,
          so it is safe inside a vibrant panel.

          The card is the SCROLL BOUNDARY too, which is what makes it read as
          one object: rows disappear under its rounded top edge rather than
          sliding past a straight seam. */}
      <div
        className="relative mx-1.5 mb-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-[var(--comms-surface)]"
        style={{
          // Same reasoning as CommsSurface: on a near-black panel the shadow
          // has almost nothing to darken, so the ring carries the edge.
          boxShadow: "0 0 0 1px rgba(255,255,255,0.08), 0 10px 28px rgba(0,0,0,0.6)",
        }}
      >
        {/* ONE scroller for everything below the org row. The navigation used to
            be pinned above it, which cost ~200px of permanently-frozen height —
            on a short window the project list was reduced to a slot a few rows
            tall while six fixed rows sat above it. Only the titlebar band and
            the org row are fixed now; the nav scrolls away with the lists.

            It sits INSIDE `parentRef` rather than in a wrapper: the virtualizer
            measures its scroll element, and anything between it and the rows
            would have to be subtracted from every offset by hand. As a plain
            block before the virtualized region, it simply displaces it. */}
        {/* Fades, not a scrollbar: rows enter and leave at the card's rounded
            edges, and a hard cut there reads as clipping. Anchored to the CARD
            (its `relative`), so the bottom one sits above the footer row rather
            than under it. `pointer-events-none` so neither eats a click, and
            plain gradients — no blur, no transform — so they cost a paint and
            nothing else. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-6 rounded-t-[10px]"
          style={{
            background:
              "linear-gradient(to bottom, var(--comms-surface) 20%, color-mix(in srgb, var(--comms-surface) 55%, transparent) 60%, transparent)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-[30px] z-[2] h-6"
          style={{
            background:
              "linear-gradient(to top, var(--comms-surface) 20%, color-mix(in srgb, var(--comms-surface) 55%, transparent) 60%, transparent)",
          }}
        />
        <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto hide-scrollbar px-2 py-1.5">
          {/* Navigation, in three bands. Organisation-wide destinations
           *  first (Timeline, Chat, Members); then the project-scoped tools under
           *  their own collapsible "Modules" heading — the same disclosure the
           *  list below uses, so the rail reads as one outline — ending, as
           *  Linear's does, in "More", the ⌘⌥N module palette. Logs and Skills left
           *  the rail: Console and Settings in the org row already reach them. */}
          <nav ref={navRef} className="pt-1 pb-1 space-y-px">
            <CaptureControl />
            <NavItem
              icon={<MessagesSquare size={14} />}
              label="Chat"
              active={rightMode === "chat"}
              disabled={!orgSynced}
              title={orgSynced ? undefined : "Sync this organisation to use team chat"}
              onClick={() => toggleRightPanelMode("chat")}
            />
            <NavItem
              icon={<Users size={14} />}
              label="Members"
              disabled={!orgSynced}
              title={orgSynced ? undefined : "Sync this organisation to manage members"}
              onClick={() => setMembersOpen(true)}
            />

            <SectionHeaderRow
              label="Modules"
              collapsed={!!collapsed["sec:tools"]}
              onToggle={() => toggle("sec:tools")}
            />
            {!collapsed["sec:tools"] && (
              <>
                <NavItem
                  icon={<Sparkles size={14} />}
                  label="Agents"
                  disabled={!hasProject}
                  title={hasProject ? undefined : "Open a project to start an agent"}
                  // Zero-arg wrapper, NOT a bare reference: openNewAgentChat's
                  // optional parameter would otherwise receive the click event.
                  onClick={() => openNewAgentChat()}
                />
                <NavItem
                  icon={<BookOpen size={14} />}
                  label="Knowledge"
                  disabled={!hasProject}
                  title={hasProject ? undefined : "Open a project to open its knowledge base"}
                  onClick={openKnowledge}
                />
                <NavItem
                  icon={<TerminalSquare size={14} />}
                  label="Terminal"
                  onClick={() =>
                    // Mirrors `tabs.newTerminal` in App.tsx: a fresh tab each time.
                    addTab({
                      id: `terminal-${Date.now()}`,
                      type: "terminal",
                      title: "Terminal",
                      closable: true,
                      dirty: false,
                      data: {},
                    })
                  }
                />
                <NavItem
                  icon={<GitBranch size={14} />}
                  label="Source control"
                  active={rightMode === "source-control"}
                  disabled={!hasProject}
                  title={hasProject ? undefined : "Open a project to see its source control"}
                  onClick={() => toggleRightPanelMode("source-control")}
                />
                <NavItem
                  icon={<Ellipsis size={14} />}
                  label="More"
                  title={newTabHint ? `Open a module (${newTabHint})` : "Open a module"}
                  onClick={() => window.dispatchEvent(new CustomEvent("atlas:new-tab-palette"))}
                />
              </>
            )}
          </nav>

          {rows.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-[var(--text-tertiary)]">
              No projects yet.
            </div>
          ) : (
            <div
              style={{
                height: virtualizer.getTotalSize() - scrollMargin,
                position: "relative",
              }}
            >
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
                      // `scrollMargin` is baked into `v.start` (it is measured
                      // from the SCROLLER's top, past the nav); subtract it to get
                      // the offset within this wrapper.
                      transform: `translateY(${v.start - scrollMargin}px)`,
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

        {/* Card footer: help on the left, version on the right. Outside the
            scroller so it stays put, inside the card so it belongs to it. */}
        <div className="relative z-[2] flex h-[30px] shrink-0 items-center justify-between px-2">
          <HelpMenu />
          <AppVersion />
        </div>
      </div>
      <MembersModal org={activeOrg} open={membersOpen} onOpenChange={setMembersOpen} />
    </aside>
  );
}

/** One row of the fixed navigation: 28px, icon in the quiet weight, label in
 *  the body weight, both stepping up together on hover. `active` is the
 *  resting fill of the row whose panel is open. */
function NavItem({
  icon,
  label,
  onClick,
  active,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        "group/nav flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-left text-[12px] leading-none outline-none transition-colors cursor-pointer",
        "disabled:cursor-default disabled:opacity-40",
        active
          ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          active
            ? "text-[var(--text-primary)]"
            : "text-[var(--text-tertiary)] group-hover/nav:text-[var(--text-secondary)]",
        )}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Help / community. A dropdown rather than a link so the menu has somewhere
 *  to grow — Discord is the first entry, not the only one it will hold. */
function HelpMenu() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Help & community"
          aria-label="Help and community"
          className="flex size-[22px] items-center justify-center rounded-full border border-white/[0.08] text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
        >
          <HelpCircle size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={6}
          style={{ zIndex: 9999, boxShadow: "0 16px 48px rgba(0,0,0,0.95)" }}
          className="w-[200px] overflow-hidden rounded-xl border border-white/[0.07] bg-[var(--bg-elevated)]/95 p-1 backdrop-blur-2xl select-none"
        >
          <DropdownMenu.Item
            onSelect={() => void openUrl("https://discord.gg/atlas")}
            className="flex h-[26px] items-center gap-2 rounded-md px-1.5 text-[11px] text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <MessageCircle size={12} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="flex-1 text-left">Discord community</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The running build's version. Read from Tauri rather than `package.json`:
 *  the bundle carries its own version, and a stale import would claim the
 *  wrong one after an update. Renders nothing until it resolves. */
function AppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void getVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {
        // Not worth surfacing: a missing version number costs the reader
        // nothing, and this runs on every rail mount.
      });
    return () => {
      live = false;
    };
  }, []);
  if (!version) return null;
  return (
    <span className="select-none pr-1 font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]">
      v{version}
    </span>
  );
}

/** The rail's small ghost icon buttons (titlebar band). */
function RailIconButton({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex size-6 items-center justify-center rounded-md outline-none transition-colors cursor-pointer hover:bg-[var(--bg-hover)]",
        active
          ? "text-[var(--accent-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
      )}
    >
      {children}
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
          className="flex size-6 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors cursor-pointer"
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
