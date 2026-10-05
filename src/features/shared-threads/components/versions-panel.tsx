import { useCallback, useEffect, useState } from "react";
import { Bookmark, History, RotateCcw } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DiffView } from "@/features/git/components/diff-view";
import type { DiffHunk } from "@/features/git/lib/diff";

import { useLineComments } from "../lib/use-line-comments";
import { LineCommentList, NewLineComment, threadsOf } from "./line-comments";
import {
  diffAgainst,
  listVersions,
  markVersion,
  onVersionsChanged,
  restoreToVersion,
  sharedThreadError,
  type FileDiff,
  type LineSpan,
  type SharedThreadError,
  type SharedThreadRun,
  type ThreadVersion,
} from "../lib/shared-threads-api";

/**
 * Thread Versions on the desktop (ATL-419): the thread's changed files
 * against a base the person picks — the Base, the last Run, or any Thread
 * Version — and, for a participant, Restore chosen files to that Version
 * (a new change everyone sees) and Mark the thread as it is now.
 */

const SELECT_CLASS =
  "h-7 min-w-0 max-w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none disabled:opacity-40";

/** What the files are compared with. */
export type DiffBase = { kind: "base" } | { kind: "version"; version: number };

const CHANGE: Record<FileDiff["change"], string> = {
  added: "Added",
  modified: "Changed",
  deleted: "Deleted",
  binary: "Binary changed",
  unavailable: "Not available",
};

/** A Version in words: what made it, who, and its mark. */
export function versionLabel(
  v: ThreadVersion,
  runs: SharedThreadRun[],
  nameOf: (userId: string) => string,
): string {
  const run = v.runId ? runs.find((r) => r.runId === v.runId) : undefined;
  const what =
    v.kind === "merge"
      ? run
        ? `Run #${run.runNo} by ${nameOf(run.runnerId)}`
        : `a Run by ${nameOf(v.authorId)}`
      : v.kind === "resolve"
        ? `Conflict resolved by ${nameOf(v.authorId)}`
        : v.kind === "restore"
          ? `restored to ${v.restoredFrom ?? "?"} by ${nameOf(v.authorId)}`
          : `marked by ${nameOf(v.authorId)}`;
  const mark = v.mark?.label ? ` · ${v.mark.label}` : "";
  return `Version ${v.version} · ${what}${mark}`;
}

/** The last Run's Thread Version: the newest merged Run's. */
export function lastRunVersion(runs: SharedThreadRun[]): number | null {
  const merged = runs.filter((r) => r.status === "merged" && r.mergedVersion !== null);
  merged.sort((a, b) => b.runNo - a.runNo);
  return merged[0]?.mergedVersion ?? null;
}

/**
 * The lines of the file as it is now that a hunk — or the lines picked in it —
 * covers; `null` when only removed lines were picked, whose text is gone.
 */
export function hunkLines(hunk: DiffHunk, selected?: number[]): LineSpan | null {
  const picked = selected && selected.length > 0 ? selected.map((i) => hunk.lines[i]) : hunk.lines;
  const now = picked.flatMap((l) => (l?.newLine !== undefined ? [l.newLine] : []));
  if (now.length === 0) return null;
  return { start: Math.min(...now), end: Math.max(...now) };
}

function baseKey(b: DiffBase): string {
  return b.kind === "base" ? "base" : `v:${b.version}`;
}

function parseKey(key: string): DiffBase {
  return key === "base" ? { kind: "base" } : { kind: "version", version: Number(key.slice(2)) };
}

export function VersionsPanel({
  sharedThreadId,
  head,
  runs,
  canEdit,
  me,
  nameOf,
}: {
  sharedThreadId: string;
  /** The thread's head as this replica knows it: a change re-reads the diff. */
  head: number;
  runs: SharedThreadRun[];
  /** A participant of an open thread; a viewer may only switch the base. */
  canEdit: boolean;
  /** Who this person is, for their own votes. */
  me?: string | null;
  nameOf: (userId: string) => string;
}) {
  // Line comments (ATL-416): anyone who can read the project may comment —
  // viewers too — on the diff's lines as the files read now.
  const comments = useLineComments(sharedThreadId);
  const [composing, setComposing] = useState<{ path: string; lines: LineSpan } | null>(null);
  const [versions, setVersions] = useState<ThreadVersion[]>([]);
  const [against, setAgainst] = useState<DiffBase>({ kind: "base" });
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<SharedThreadError | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState(false);
  const [bump, setBump] = useState(0);

  const loadVersions = useCallback(() => {
    listVersions(sharedThreadId)
      .then(setVersions)
      .catch((e) => setError(sharedThreadError(e)));
  }, [sharedThreadId]);

  useEffect(() => {
    loadVersions();
    let unlisten: (() => void) | undefined;
    void onVersionsChanged(({ sharedThreadId: id }) => {
      if (id !== sharedThreadId) return;
      loadVersions();
      setBump((b) => b + 1);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [sharedThreadId, loadVersions]);

  useEffect(() => {
    let live = true;
    setError(null);
    diffAgainst(sharedThreadId, against.kind === "version" ? against.version : null)
      .then((d) => live && setDiffs(d))
      .catch((e) => {
        if (!live) return;
        setDiffs(null);
        setError(sharedThreadError(e));
      });
    return () => {
      live = false;
    };
  }, [sharedThreadId, against, head, bump]);

  async function act(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(sharedThreadError(e));
    } finally {
      setBusy(false);
    }
  }

  const last = lastRunVersion(runs);
  const options: Array<[string, string]> = [["base", "The Base"]];
  if (last !== null) options.push([`v:${last}`, `Last Run · Version ${last}`]);
  for (const v of versions) {
    if (v.version !== last) options.push([`v:${v.version}`, versionLabel(v, runs, nameOf)]);
  }
  const restorable = (diffs ?? []).filter((d) => d.restorable);
  const atVersion = against.kind === "version" ? against.version : null;

  return (
    <section className="flex flex-col gap-1.5" aria-label="Thread Versions">
      <span className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-[var(--muted-foreground)]">
        <History size={11} /> Changes
      </span>
      <select
        aria-label="Diff against"
        value={baseKey(against)}
        onChange={(e) => setAgainst(parseKey(e.target.value))}
        className={SELECT_CLASS}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      {diffs !== null && diffs.length === 0 && (
        <p className="text-[var(--muted-foreground)]">
          {atVersion === null ? "No changes since the Base." : `No changes since Version ${atVersion}.`}
        </p>
      )}
      {diffs !== null && diffs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {diffs.map((d) => (
            <li key={d.fileId} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--secondary-foreground)]" title={d.path}>
                {d.path}
              </span>
              <Badge variant={d.change === "unavailable" ? "warning" : "outline"}>{CHANGE[d.change]}</Badge>
              {canEdit && atVersion !== null && d.restorable && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Restore ${d.path} to Version ${atVersion}`}
                  onClick={() => void act(() => restoreToVersion(sharedThreadId, atVersion, [d.fileId]))}
                >
                  <RotateCcw size={11} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {diffs !== null && diffs.some((d) => d.diff !== "") && (
          <Button size="xs" variant="outline" onClick={() => setShown((s) => !s)}>
            {shown ? "Hide diff" : "Show diff"}
          </Button>
        )}
        {canEdit && atVersion !== null && restorable.length > 0 && (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(() =>
                restoreToVersion(
                  sharedThreadId,
                  atVersion,
                  restorable.map((d) => d.fileId),
                ),
              )
            }
          >
            <RotateCcw size={11} /> Restore all to this version
          </Button>
        )}
      </div>
      {shown && diffs && (
        <div className="max-h-96 overflow-hidden rounded border border-[var(--atlas-border-subtle)]">
          <DiffView
            diff={diffs.map((d) => d.diff).filter(Boolean).join("\n")}
            hunkActions={["comment"]}
            onHunkAction={(_action, path, hunk, selected) => {
              const lines = hunkLines(hunk, selected);
              if (lines) setComposing({ path, lines });
            }}
          />
        </div>
      )}
      {composing && (
        <NewLineComment
          path={composing.path}
          lines={composing.lines}
          onSubmit={(body) => comments.comment({ path: composing.path }, composing.lines, body)}
          onCancel={() => setComposing(null)}
        />
      )}
      <LineCommentList
        threads={threadsOf(comments.comments)}
        me={me ?? null}
        nameOf={nameOf}
        canWrite
        showPath
        onReply={comments.reply}
        onResolve={comments.resolve}
        onVote={comments.vote}
      />
      {comments.error && <p className="text-error">{comments.error.message}</p>}
      {canEdit && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await markVersion(sharedThreadId, label.trim() || undefined);
              setLabel("");
              loadVersions();
            });
          }}
        >
          <input
            aria-label="Version label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            maxLength={200}
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none"
          />
          <Button size="xs" variant="outline" type="submit" disabled={busy}>
            <Bookmark size={11} /> Mark version
          </Button>
        </form>
      )}
      {error && <p className="text-error">{error.message}</p>}
    </section>
  );
}
