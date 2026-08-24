import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Archive, Download, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { deleteThread, onThreadsChanged, threadHistory, type ThreadRow } from "../lib/history-api";
import { ImportThreadsModal } from "./import-threads-modal";

/**
 * Everything the user has ever done in Atlas, bucketed by when it started.
 *
 * The counterpart to the sidebar: the sidebar shows the threads of the projects
 * you are working in, this shows all of them, archived ones included. It is
 * also where import lives, and where a thread that was archived out of the way
 * can be found again — opening one brings it back (ADR-0001).
 *
 * Same Dialog shell, tokens and row rhythm as the other full-screen lists; no
 * new visual pattern.
 */
export function ThreadHistoryView({
  open,
  onOpenChange,
  onOpenThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resume a row. Unarchiving is the backend's job, on open. */
  onOpenThread: (thread: ThreadRow) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data: threads = [] } = useQuery({
    queryKey: ["thread-history", archivedOnly],
    queryFn: () => threadHistory(archivedOnly),
    enabled: open,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    const unlisten = onThreadsChanged(() => {
      void queryClient.invalidateQueries({ queryKey: ["thread-history"] });
      void queryClient.invalidateQueries({ queryKey: ["thread-projects"] });
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, [open, queryClient]);

  // Filtering to archived when nothing is archived strands the user with an
  // empty list and a toggle that looks broken (Zed's `update_items:274-280`).
  useEffect(() => {
    if (archivedOnly && threads.length === 0) setArchivedOnly(false);
  }, [archivedOnly, threads.length]);

  const buckets = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matching = q
      ? threads.filter(
          (t) => t.title.toLowerCase().includes(q) || t.projectName.toLowerCase().includes(q),
        )
      : threads;
    return bucketByAge(matching);
  }, [threads, search]);

  const remove = useCallback(async (thread: ThreadRow) => {
    try {
      await deleteThread(thread.threadId);
    } catch (err) {
      toast.error(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border-default bg-bg-elevated shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border-default px-4 py-2.5">
            <Dialog.Title className="text-[13px] font-semibold text-text-primary">
              History
            </Dialog.Title>
            <span className="text-[11px] font-mono text-text-tertiary">
              {threads.length} {threads.length === 1 ? "thread" : "threads"}
            </span>
            <button
              type="button"
              onClick={() => setArchivedOnly((on) => !on)}
              className={cn(
                "ml-auto flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors cursor-pointer",
                archivedOnly
                  ? "bg-bg-selected text-text-primary"
                  : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary",
              )}
            >
              <Archive size={10} />
              Archived only
            </button>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
            >
              <Download size={10} />
              Import
            </button>
            <Dialog.Close
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>

          <div className="flex items-center gap-1.5 border-b border-border-default px-3 h-[32px] shrink-0">
            <Search size={11} className="shrink-0 text-text-tertiary" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search history"
              placeholder="Search…"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>

          <div className="flex-1 overflow-auto hide-scrollbar">
            {buckets.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
                {search.trim() ? "Nothing matches your search." : "No threads yet."}
              </div>
            ) : (
              buckets.map(([label, rows]) => (
                <div key={label}>
                  <div className="px-3 pt-2.5 pb-1 text-[9px] uppercase tracking-wider text-text-tertiary">
                    {label}
                  </div>
                  {rows.map((thread) => (
                    <div
                      key={thread.threadId}
                      onClick={() => {
                        onOpenThread(thread);
                        onOpenChange(false);
                      }}
                      className="group flex cursor-pointer select-none items-center gap-2 border-b border-border-subtle px-3 py-2 transition-colors last:border-b-0 hover:bg-bg-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] text-text-primary">
                          {thread.title}
                        </span>
                        <span className="block truncate text-[9px] text-text-tertiary">
                          {thread.projectName} · {agentMeta(thread.agentId).label} ·{" "}
                          {timeAgo(thread.updatedAt, { suffix: true })}
                        </span>
                      </span>
                      {thread.archived && (
                        <Archive size={10} className="shrink-0 text-text-tertiary" />
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(thread);
                        }}
                        aria-label="Delete thread"
                        title="Delete thread"
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-tertiary opacity-0 transition-opacity hover:bg-bg-elevated hover:text-[var(--status-error)] group-hover:opacity-100 cursor-pointer"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <ImportThreadsModal open={importOpen} onOpenChange={setImportOpen} />
    </Dialog.Root>
  );
}

/**
 * Group threads by when they started, newest bucket first.
 *
 * By `createdAt`, falling back to `updatedAt` — a conversation belongs to the
 * day it began, not the day someone last touched it (Zed's
 * `threads_archive_view.rs:289`). Rows arrive already in that order, so this
 * only has to cut them.
 *
 * The cuts are **calendar** cuts, not rolling windows, exactly as Zed's
 * `TimeBucket::from_dates` (`:74-90`) makes them: something from 11pm last
 * night is "Yesterday", not "Today", because that is how people remember when
 * they did things.
 */
function bucketByAge(threads: ThreadRow[]): Array<[string, ThreadRow[]]> {
  const today = startOfDay(new Date());
  const buckets = new Map<string, ThreadRow[]>();
  for (const thread of threads) {
    const started = new Date(thread.createdAt ?? thread.updatedAt);
    const label = Number.isNaN(started.getTime()) ? "Older" : bucketLabel(today, started);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(thread);
    else buckets.set(label, [thread]);
  }
  return [...buckets.entries()];
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function bucketLabel(today: Date, at: Date): string {
  const day = startOfDay(at);
  const daysApart = Math.round((today.getTime() - day.getTime()) / DAY_MS);
  if (daysApart <= 0) return "Today";
  if (daysApart === 1) return "Yesterday";
  if (isoWeek(day) === isoWeek(today)) return "This Week";
  if (isoWeek(day) === isoWeek(new Date(today.getTime() - 7 * DAY_MS))) return "Past Week";
  return "Older";
}

/** `YYYY-Www`, so two dates in the same ISO week compare equal. */
function isoWeek(date: Date): string {
  // Thursday of this date's week decides the year the week belongs to.
  const thursday = new Date(date.getTime());
  thursday.setDate(thursday.getDate() + 3 - ((date.getDay() + 6) % 7));
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      (thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS) -
        ((firstThursday.getDay() + 6) % 7) / 7,
    );
  return `${thursday.getFullYear()}-W${week}`;
}
