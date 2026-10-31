// The session menu: one context menu for the whole list, opened by a right
// click on any row or by a row's ⋯ button.
//
// One instance rather than one per row: a menu tree per row is a Base UI
// subtree per row, and the list holds a thousand. The row a `contextmenu`
// event bubbles through names itself the target on the way up; a right click
// on the list's empty space finds no target, and the menu stays shut.
//
// The items follow the reference order: branch, pin, settle, snooze; rename,
// read state, the project filter; copy, the editor, project settings; delete.

import { useState, type ReactNode, type RefObject } from "react";
import {
  Copy,
  GitPullRequest,
  List,
  Unlink,
  Folder,
  FolderTree,
  GitBranch,
  Hash,
  Type,
  AlarmClockOff,
  Clock,
  MailOpen,
  Mail,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Settings,
  CircleCheck,
  Undo2,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { snoozePresets } from "@/features/chat/lib/session-snooze";
import { OpenInEditorContextItems } from "@/features/external-editor/components/open-in-editor-menu";
import { openLinkPullRequestDialog } from "@/features/pull-requests/components/link-pull-request-dialog";
import { openSessionPullRequestsTab } from "@/features/pull-requests/lib/open-session-pull-requests-tab";
import { linkKey, orderLinks } from "@/features/pull-requests/lib/session-pull-request-links";
import { unlinkSessionPullRequest } from "@/features/pull-requests/lib/session-pull-requests-api";
import { prErrorMessage, classifyPrError } from "@/features/pull-requests/lib/pr-errors";
import { toast } from "sonner";
import type { SidebarSession } from "../lib/sidebar-sessions";
import { requestCustomSnooze } from "./custom-snooze-dialog";

/** What the menu's items do, given the session they were opened for. */
export interface SessionMenuActions {
  pin: (session: SidebarSession) => void;
  unpin: (session: SidebarSession) => void;
  newSessionOnBranch: (session: SidebarSession) => void;
  markUnread: (session: SidebarSession) => void;
  markRead: (session: SidebarSession) => void;
  snooze: (session: SidebarSession, until: string) => void;
  wake: (session: SidebarSession) => void;
  settle: (session: SidebarSession) => void;
  unsettle: (session: SidebarSession) => void;
  rename: (session: SidebarSession) => void;
  toggleProjectFilter: (session: SidebarSession) => void;
  copy: (value: string, what: string) => void;
  projectSettings: (session: SidebarSession) => void;
  delete: (session: SidebarSession) => void;
}

function SessionMenuItems({
  session,
  isPinned,
  scopedToProject,
  settleShortcut,
  actions,
}: {
  session: SidebarSession;
  isPinned: boolean;
  scopedToProject: boolean;
  settleShortcut: string | null;
  actions: SessionMenuActions;
}) {
  const settled = session.settledAt !== null;
  const presets = snoozePresets(new Date());
  return (
    <>
      {session.branch ? (
        <ContextMenuItem onClick={() => actions.newSessionOnBranch(session)}>
          <MessageSquarePlus />
          <span className="min-w-0 truncate">New session on {session.branch}</span>
        </ContextMenuItem>
      ) : null}
      {settled ? null : isPinned ? (
        <ContextMenuItem onClick={() => actions.unpin(session)}>
          <PinOff />
          Unpin session
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => actions.pin(session)}>
          <Pin />
          Pin session
        </ContextMenuItem>
      )}
      {settled ? (
        <ContextMenuItem onClick={() => actions.unsettle(session)}>
          <Undo2 />
          Un-settle session
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => actions.settle(session)}>
          <CircleCheck />
          Settle session
          {settleShortcut ? <ContextMenuShortcut>{settleShortcut}</ContextMenuShortcut> : null}
        </ContextMenuItem>
      )}
      {settled ? null : session.snoozedUntil !== null ? (
        <ContextMenuItem onClick={() => actions.wake(session)}>
          <AlarmClockOff />
          Wake session
        </ContextMenuItem>
      ) : (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Clock />
            Snooze
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {presets.map((preset) => (
              <ContextMenuItem
                key={preset.id}
                onClick={() => actions.snooze(session, preset.until)}
              >
                {preset.label}
                <ContextMenuShortcut>{preset.whenLabel}</ContextMenuShortcut>
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={async () => {
                const until = await requestCustomSnooze();
                if (until) actions.snooze(session, until);
              }}
            >
              Custom…
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => actions.rename(session)}>
        <Pencil />
        Rename session
      </ContextMenuItem>
      {session.unread ? (
        <ContextMenuItem onClick={() => actions.markRead(session)}>
          <MailOpen />
          Mark read
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => actions.markUnread(session)}>
          <Mail />
          Mark unread
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => actions.toggleProjectFilter(session)}>
        <FolderTree />
        <span className="min-w-0 truncate">
          {scopedToProject ? "Show all projects" : `Filter by ${session.projectName}`}
        </span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {session.pullRequests.length > 0 ? (
        <ContextMenuItem
          onClick={() =>
            openSessionPullRequestsTab({
              threadId: session.threadId,
              cwd: session.cwd,
              title: session.title,
            })
          }
        >
          <List />
          Show pull requests
          <span className="ml-auto tabular-nums">{session.pullRequests.length}</span>
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        onClick={() =>
          openLinkPullRequestDialog({
            threadId: session.threadId,
            repoPath: session.cwd,
            linked: session.pullRequests.map(linkKey),
            checkouts: session.attachedProjects.map((project) => project.path),
          })
        }
      >
        <GitPullRequest />
        Link a pull request…
      </ContextMenuItem>
      {session.pullRequests.length > 0 ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Unlink />
            Unlink pull request
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {orderLinks(session.pullRequests).map((link) => (
              <ContextMenuItem
                key={linkKey(link)}
                onClick={() =>
                  void unlinkSessionPullRequest(
                    session.threadId,
                    link.repository,
                    link.number,
                  ).catch((raw: unknown) =>
                    toast.error("Could not unlink the pull request", {
                      description: prErrorMessage(classifyPrError(raw)),
                    }),
                  )
                }
              >
                <span className="min-w-0 truncate">
                  #{link.number} {link.snapshot?.title ?? link.repository}
                </span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Copy />
          Copy
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => actions.copy(session.title, "Title")}>
            <Type />
            Title
          </ContextMenuItem>
          <ContextMenuItem onClick={() => actions.copy(session.cwd, "Path")}>
            <Folder />
            Path
          </ContextMenuItem>
          {session.branch ? (
            <ContextMenuItem onClick={() => actions.copy(session.branch!, "Branch")}>
              <GitBranch />
              Branch
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onClick={() => actions.copy(session.threadId, "Session ID")}>
            <Hash />
            Session ID
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <OpenInEditorContextItems path={session.cwd} withIcons />
      <ContextMenuItem onClick={() => actions.projectSettings(session)}>
        <Settings />
        Project settings
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => actions.delete(session)}>
        <Trash2 />
        Delete…
      </ContextMenuItem>
    </>
  );
}

/**
 * Wraps the list. A row's `contextmenu` handler writes its session into
 * `pendingRef` — it runs before the menu's own, on the way up — and the menu
 * takes it from there. The open state is controlled so a right click that
 * named no row can be refused before anything shows.
 */
export function SessionRowMenu({
  scopedToProject,
  settleShortcut,
  actions,
  pendingRef,
  children,
}: {
  scopedToProject: boolean;
  settleShortcut: string | null;
  actions: SessionMenuActions;
  pendingRef: RefObject<SidebarSession | null>;
  children: ReactNode;
}) {
  const pending = pendingRef;
  const [target, setTarget] = useState<SidebarSession | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const session = pending.current;
          pending.current = null;
          if (!session) return;
          setTarget(session);
        }
        setOpen(next);
      }}
    >
      <ContextMenuTrigger
        render={<div className="flex min-h-0 flex-1 flex-col" />}
        // Cleared on the way down, so a click on empty space finds nothing
        // left over from the last row.
        onContextMenuCapture={() => {
          pending.current = null;
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {target ? (
          <SessionMenuItems
            session={target}
            isPinned={target.pinnedAt !== null}
            scopedToProject={scopedToProject}
            settleShortcut={settleShortcut}
            actions={actions}
          />
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
