// The Details card's Changes section: every file this session changed, the
// one place the card says it.
//
// Two sources, joined (`mergeChanges`): the capture record, which is every
// file the session changed however it changed it, and the session's own
// per-turn tally, which carries the line counts and the running turn's edits
// the moment they land. Either alone was wrong in a way the reader could not
// see: the tally missed every shell edit, and read nothing until turn end.
//
// A session that has changed nothing yet says so, and points at the working
// tree's uncommitted changes when there are some (what Source Control would
// commit), so that count is never shown beside the session's own.

import { useMemo } from "react";
import { ChevronRight, FileDiff } from "lucide-react";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { changesStatus, mergeChanges, tallyChanges } from "@/features/chat/lib/session-overview";
import { useSessionFiles } from "@/features/chat/lib/session-files";
import { openSessionChanges } from "@/features/git/lib/open-session-changes";
import { useGitStore } from "@/features/git/stores/git-store";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { cn } from "@/lib/utils";

import { revealSourceControl } from "../lib/git-actions";
import { ContextRow, ContextSection, RowIcon, RowLabel, RowMeta } from "./context-rows";

/** The diff's file tree's colours for the same letters (`diff-file-tree.tsx`). */
const STATUS_COLOR = {
  A: "var(--atlas-status-success-foreground)",
  M: "var(--atlas-status-warning-foreground)",
  D: "var(--atlas-status-error-foreground)",
} as const;
const STATUS_LABEL = { A: "Added", M: "Modified", D: "Deleted" } as const;

export function ChangesSection({
  tabId,
  projectPath,
}: {
  tabId: string;
  projectPath: string | null;
}) {
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const messages = useChatStore((s) => s.sessions[tabId]?.messages);
  // The running turn's scratch. Replaced per tool upsert, which is the rate a
  // reader watching the turn wants; the rows under it are few and cheap.
  const live = useChatStore((s) => s.sessions[tabId]?.turnScratch?.tools);
  const recorded = useSessionFiles(projectPath, acpSessionId);
  const tally = useMemo(() => tallyChanges(messages ?? [], live), [messages, live]);
  const rows = useMemo(
    () => mergeChanges(recorded, tally, projectPath ?? ""),
    [recorded, tally, projectPath],
  );
  // Clicking a file shows the session's changes beside it, at that file. Needs
  // a session id: the tab is keyed by it and reads the record through it.
  const open =
    projectPath && acpSessionId
      ? (file: string) =>
          openSessionChanges({
            projectPath,
            sessionId: acpSessionId,
            file,
            title: useLayoutStore.getState().tabs.find((t) => t.id === tabId)?.title,
          })
      : null;
  return (
    <ContextSection
      title="Changes"
      collapse={{
        id: "changes",
        badge: rows.length > 0 ? `${rows.length}` : "",
        badgeTitle: changesStatus(rows),
      }}
    >
      {rows.length === 0 ? (
        <NoChanges projectPath={projectPath} readCount={tally.readCount} />
      ) : (
        <ul className="m-0 hide-scrollbar max-h-64 list-none overflow-y-auto overscroll-contain p-0">
          {rows.map((file) => (
            <li
              key={file.path}
              role={open ? "button" : undefined}
              tabIndex={open ? 0 : undefined}
              onClick={open ? () => open(file.path) : undefined}
              onKeyDown={
                open
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(file.path);
                      }
                    }
                  : undefined
              }
              className={cn(
                "flex h-7 items-center gap-2.5 rounded-lg px-2.5",
                open &&
                  "cursor-pointer outline-none transition-colors hover:bg-element-hover focus-visible:bg-element-hover",
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {file.status ? (
                  <span
                    className="font-mono text-2xs font-medium"
                    style={{ color: STATUS_COLOR[file.status] }}
                    aria-label={STATUS_LABEL[file.status]}
                  >
                    {file.status}
                  </span>
                ) : (
                  <FileIcon path={file.path} size={12} />
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs text-secondary-foreground",
                  file.deleted && "line-through opacity-60",
                )}
                title={file.path}
              >
                {file.path.split("/").pop()}
              </span>
              {file.added !== undefined &&
              file.removed !== undefined &&
              (file.added > 0 || file.removed > 0) ? (
                <span className="shrink-0 font-mono text-2xs tabular-nums">
                  <span className="text-success">+{file.added}</span>
                  <span className="ml-1 text-error">−{file.removed}</span>
                </span>
              ) : (
                <ChevronRight size={12} className="shrink-0 text-muted-foreground" aria-hidden />
              )}
            </li>
          ))}
        </ul>
      )}
    </ContextSection>
  );
}

/** Nothing changed by the session: say so in one muted line, and offer the
 *  working tree's uncommitted changes where the project has some. */
function NoChanges({ projectPath, readCount }: { projectPath: string | null; readCount: number }) {
  const workingTree = useGitStore((s) =>
    projectPath && s.repoPath === projectPath && s.isRepo ? s.files.length : 0,
  );
  return (
    <>
      <p className="px-2.5 pb-1 text-2xs text-muted-foreground">
        {readCount > 0 ? `${readCount} files read, none changed.` : "No changes yet."}
      </p>
      {workingTree > 0 && (
        <ContextRow title="Uncommitted changes in the working tree" onClick={revealSourceControl}>
          <RowIcon icon={FileDiff} />
          <RowLabel>Working tree</RowLabel>
          <RowMeta>
            {workingTree} {workingTree === 1 ? "file" : "files"}
          </RowMeta>
        </ContextRow>
      )}
    </>
  );
}
