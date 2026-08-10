/**
 * Recent Checkpoints — a searchable jump list in the Timeline header.
 *
 * The board answers "what has been happening"; this answers the other question
 * people actually arrive with: *"where is the commit I made this morning?"*
 * Finding it on the board means knowing which Session produced it first, which
 * is exactly the thing you have forgotten. So the commits are listed directly,
 * and picking one opens its Session scrolled to that Checkpoint — the same jump
 * the git panel's history view performs.
 *
 * Rows are two lines, not the reference's three: the subject is the line you
 * scan, and the sha, branch and diffstat are supporting detail that belongs
 * beside it rather than under it. At 300px the second line would truncate the
 * subject to make room for facts nobody reads first.
 */

import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, GitCommitHorizontal, Loader2, Unlink } from "lucide-react";

import { timeAgo } from "@/lib/time-ago";

import { SEGMENT_TRIGGER } from "./segment";

import type { BoardCheckpoint } from "../types";

export function CheckpointsPicker({
  projects,
  onOpen,
}: {
  /** Project paths to read, same set the board reads. */
  projects: string[];
  onOpen: (checkpoint: BoardCheckpoint) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BoardCheckpoint[] | null>(null);
  const [query, setQuery] = useState("");
  /** Only the newest read may write state — `invoke` has no abort. */
  const seq = useRef(0);

  // Depend on the CONTENT of `projects`, not its identity. The parent builds
  // `projectFilter ? [projectFilter] : projectPaths`, which is a fresh array on
  // every render whenever a filter is set — so depending on the array itself
  // re-ran this on each parent render and re-read while the menu sat open.
  const projectsKey = projects.join("\n");

  // Read on open, not on mount: this is a dropdown most sessions never touch,
  // and it costs a `git show` per commit across every captured project.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setRows(null);
    invoke<BoardCheckpoint[]>("artifacts_checkpoints", { projects })
      .then((result) => {
        if (mine === seq.current) setRows(result);
      })
      .catch(() => {
        if (mine === seq.current) setRows([]);
      });
    // `projectsKey` stands in for `projects`: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectsKey]);

  const q = query.trim().toLowerCase();
  const filtered = (rows ?? []).filter((row) => {
    if (!q) return true;
    // Everything visible on the row is searchable, plus the sha — which is the
    // one thing people paste in rather than type.
    return [row.commitSubject, row.commitSha, row.branch, row.sessionTitle, row.projectName].some(
      (field) => field?.toLowerCase().includes(q),
    );
  });

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Recent checkpoints"
          title="Recent checkpoints"
          className={SEGMENT_TRIGGER}
        >
          <GitCommitHorizontal size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-[var(--z-max)] flex max-h-[380px] w-[320px] origin-[var(--radix-popover-content-transform-origin)] flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[#000] shadow-xl data-[state=closed]:animate-scale-out data-[state=open]:animate-scale-in"
        >
          <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
              Checkpoints
            </span>
            <div className="flex-1" />
            {rows === null ? (
              <Loader2 size={10} className="animate-spin text-[var(--text-tertiary)]" />
            ) : (
              <span className="text-[9px] tabular-nums text-[var(--text-ghost)]">
                {filtered.length}
              </span>
            )}
          </div>

          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commits…"
            className="h-[28px] shrink-0 border-b border-[var(--border-default)] bg-transparent px-3 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />

          <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
            {rows === null ? (
              <p className="px-3 py-4 text-center text-[11px] text-[var(--text-tertiary)]">
                Reading checkpoints…
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-[11px] text-[var(--text-tertiary)]">
                {rows.length === 0
                  ? "No commits have been linked to a session yet."
                  : `Nothing matches “${query.trim()}”.`}
              </p>
            ) : (
              filtered.map((row) => (
                <Popover.Close asChild key={`${row.projectPath}:${row.sessionId}:${row.commitSha}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(row)}
                    title={row.sessionTitle ?? undefined}
                    className="flex w-full cursor-pointer items-start gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5 text-left transition-colors last:border-b-0 hover:bg-[var(--bg-hover)]"
                  >
                    {/* Orphaned means the commit its Checkpoint pointed at is
                        gone — a rebase or an amend. Worth a different glyph,
                        because clicking it lands on a Session whose commit no
                        longer exists. */}
                    <span className="mt-[3px] shrink-0 text-[var(--text-tertiary)]">
                      {row.linkState === "orphaned" ? (
                        <Unlink size={11} className="text-[var(--status-warning)]" />
                      ) : (
                        <GitCommitHorizontal size={11} />
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[11px] leading-tight text-[var(--text-primary)]">
                          {row.commitSubject ?? (
                            <span className="text-[var(--text-tertiary)]">
                              {row.sessionTitle ?? "Checkpoint"}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[9px] tabular-nums text-[var(--text-ghost)]">
                          {timeAgo(row.at)}
                        </span>
                      </span>

                      <span className="mt-0.5 flex items-center gap-1.5 text-[9px] leading-tight text-[var(--text-tertiary)]">
                        <span className="shrink-0 font-mono">{row.commitSha.slice(0, 7)}</span>
                        {row.branch && (
                          <>
                            <GitBranch size={8} className="shrink-0" />
                            <span className="min-w-0 truncate font-mono">{row.branch}</span>
                          </>
                        )}
                        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono">
                          {row.insertions > 0 && (
                            <span className="text-[var(--stat-added)]">+{row.insertions}</span>
                          )}
                          {row.deletions > 0 && (
                            <span className="text-[var(--stat-removed)]">−{row.deletions}</span>
                          )}
                        </span>
                      </span>
                    </span>
                  </button>
                </Popover.Close>
              ))
            )}
          </div>

          {/* The project is on its own line only when the list spans more than
              one — inside a filtered board it is the same value on every row. */}
          {rows !== null && filtered.length > 0 && (
            <p className="shrink-0 border-t border-[var(--border-default)] px-3 py-1 text-[9px] text-[var(--text-ghost)]">
              {new Set(filtered.map((r) => r.projectPath)).size > 1
                ? `Across ${new Set(filtered.map((r) => r.projectPath)).size} projects`
                : filtered[0].projectName}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
