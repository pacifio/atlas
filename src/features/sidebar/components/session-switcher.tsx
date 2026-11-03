// The session's crumb in the title bar (`org › project › session`), as a
// switch: it opens the open project's sessions, newest first with the pinned
// ones on top, and a search and a New session (+) at the head of the list.
// It is how a session is started and how one moves between a project's
// sessions without the sidebar — whose own list can be filtered to other
// projects (`session-scope-filter.tsx`) and no longer carries a + of its own.
//
// The list is the sidebar's (`useProjectSessions`): the same history, read
// through the same query, scoped to the open project. A search also reaches
// the settled sessions.

import { useMemo, useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Check, Plus, Search } from "lucide-react";

import { BreadcrumbButton } from "@/components/breadcrumb-button";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";

import {
  useActiveSessionId,
  useLiveSessions,
  useProjectSessions,
} from "../hooks/use-sidebar-sessions";
import { openSession } from "../lib/sidebar-actions";
import type { SidebarSession } from "../lib/sidebar-sessions";
import {
  MENU_EMPTY,
  MENU_HEADING,
  MENU_ITEM,
  MENU_ITEM_SELECTED,
  MENU_LIST,
  MENU_SEARCH,
  MENU_SEARCH_INPUT,
  MENU_SURFACE,
} from "../lib/menu-surface";
import { RelativeTime, SessionAgentIcon, WorkingRing } from "./session-row-parts";

/** The rows a query keeps: by title, case-insensitively. */
function matches(session: SidebarSession, needle: string): boolean {
  return session.title.toLowerCase().includes(needle);
}

export function SessionSwitcher({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const newSessionShortcut = useActionShortcut("tabs.newChat")?.label;

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DropdownMenu.Trigger
        render={
          <BreadcrumbButton
            className="max-w-[320px] text-foreground"
            aria-label={`Session: ${title}. Switch session`}
          >
            {title}
          </BreadcrumbButton>
        }
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" side="bottom" align="start" sideOffset={6}>
          <DropdownMenu.Popup className={MENU_SURFACE}>
            {/* Mounted only while open: the list is read and partitioned
                for the menu, not for every title bar. */}
            {open && (
              <SessionList
                query={query}
                onQueryChange={setQuery}
                newSessionShortcut={newSessionShortcut}
                onClose={() => setOpen(false)}
              />
            )}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SessionList({
  query,
  onQueryChange,
  newSessionShortcut,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  newSessionShortcut: string | undefined;
  onClose: () => void;
}) {
  const projectId = useProjectStore.use.activeProjectId();
  const { partition, isLoading } = useProjectSessions(projectId);
  const activeSessionId = useActiveSessionId();
  const live = useLiveSessions();
  const needle = query.trim().toLowerCase();

  const sections = useMemo(() => {
    if (needle) {
      const all = [
        ...partition.pinned,
        ...partition.active,
        ...partition.snoozed,
        ...partition.settled,
      ].filter((s) => matches(s, needle));
      return [{ label: null, rows: all }];
    }
    return [
      { label: "Pinned", rows: partition.pinned },
      { label: partition.pinned.length > 0 ? "Recent" : null, rows: partition.active },
      { label: "Snoozed", rows: partition.snoozed },
    ].filter((section) => section.rows.length > 0);
  }, [partition, needle]);
  const empty = sections.every((section) => section.rows.length === 0);

  const startNew = () => {
    onClose();
    openNewAgentChat();
  };

  return (
    <>
      <div
        className={MENU_SEARCH}
        onKeyDown={(event) => {
          // Keep keys from the menu's typeahead and arrow nav; Escape still
          // closes it, and Enter with a query opens the first match.
          if (event.key === "Enter") {
            const first = sections[0]?.rows[0];
            if (first) {
              event.preventDefault();
              onClose();
              openSession(first);
            }
            return;
          }
          if (event.key !== "Escape" && event.key !== "ArrowDown") event.stopPropagation();
        }}
      >
        <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search sessions…"
          aria-label="Search this project's sessions"
          className={MENU_SEARCH_INPUT}
        />
        <Hint label="New session" shortcut={newSessionShortcut} side="bottom">
          <button
            type="button"
            aria-label="New session"
            disabled={!projectId}
            onClick={startNew}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-default disabled:opacity-40"
          >
            <Plus aria-hidden className="size-3.5" />
          </button>
        </Hint>
      </div>

      <div className={MENU_LIST}>
        {empty ? (
          <div className={MENU_EMPTY}>
            {isLoading
              ? "Loading…"
              : needle
                ? "No matching sessions."
                : "No sessions in this project yet."}
          </div>
        ) : (
          sections.map((section) => (
            <DropdownMenu.Group key={section.label ?? "all"}>
              {section.label && (
                <DropdownMenu.GroupLabel className={MENU_HEADING}>
                  {section.label}
                </DropdownMenu.GroupLabel>
              )}
              {section.rows.map((session) => {
                const current = session.sessionId !== "" && session.sessionId === activeSessionId;
                const status = live.get(session.sessionId)?.status;
                return (
                  <DropdownMenu.Item
                    key={session.threadId}
                    onClick={() => {
                      if (!current) openSession(session);
                    }}
                    className={cn(MENU_ITEM, current && MENU_ITEM_SELECTED)}
                  >
                    {/* A fixed box: the agents' marks differ in width, and the titles
                        should start in one column. */}
                    <span className="flex size-4 shrink-0 items-center justify-center opacity-70">
                      <SessionAgentIcon agent={session.agent} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    {current ? (
                      <Check aria-hidden className="size-3.5 shrink-0" />
                    ) : status === "running" || status === "waiting" ? (
                      <span className="inline-flex shrink-0 text-info">
                        <WorkingRing />
                      </span>
                    ) : (
                      <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                        <RelativeTime iso={session.updatedAt} />
                      </span>
                    )}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Group>
          ))
        )}
      </div>
    </>
  );
}
