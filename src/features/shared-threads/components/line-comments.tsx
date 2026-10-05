import { useState } from "react";
import { Check, MessageSquarePlus, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";

import type { LineComment, LineSpan } from "../lib/shared-threads-api";

/**
 * Comments on lines of a Shared Thread's files on the desktop (ATL-416):
 * each discussion on the lines it covers in the text now, or — when its text
 * is gone — marked outdated with the lines it was written on. Replies,
 * resolve and votes go through the thread's comment doors, as on the web.
 */

/** A root and its replies. */
export interface LineThread {
  root: LineComment;
  replies: LineComment[];
}

/** One file's discussions — or every file's — placed ones first by line, then outdated. */
export function threadsOf(comments: LineComment[], fileId?: number): LineThread[] {
  const roots = comments.filter(
    (c) => c.parentId === null && c.threadRange !== null && (fileId === undefined || c.threadRange.fileId === fileId),
  );
  const threads = roots.map((root) => ({ root, replies: comments.filter((c) => c.parentId === root.id) }));
  return threads.sort((a, b) => {
    const la = a.root.lines?.start ?? Number.MAX_SAFE_INTEGER;
    const lb = b.root.lines?.start ?? Number.MAX_SAFE_INTEGER;
    return la - lb || a.root.createdAt.localeCompare(b.root.createdAt);
  });
}

/** Lines in words: "Line 4" or "Lines 4–6". */
export function linesLabel(lines: LineSpan): string {
  return lines.start === lines.end ? `Line ${lines.start}` : `Lines ${lines.start}–${lines.end}`;
}

/** The lines open discussions are on now, for the editor's markers. */
export function commentedLines(comments: LineComment[], fileId: number): LineSpan[] {
  return threadsOf(comments, fileId)
    .filter((t) => t.root.resolvedAt === null && t.root.lines !== null)
    .map((t) => t.root.lines!);
}

const TEXTAREA =
  "w-full resize-y rounded border border-[var(--atlas-border-subtle)] bg-[var(--background)] p-1.5 text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]";

export function LineCommentList({
  threads,
  me,
  nameOf,
  canWrite,
  showPath = false,
  onReply,
  onResolve,
  onVote,
}: {
  threads: LineThread[];
  me: string | null;
  nameOf: (userId: string) => string;
  /** Anyone who can read the project may comment; `false` while signed out or offline. */
  canWrite: boolean;
  showPath?: boolean;
  onReply: (parentId: string, body: string) => Promise<unknown>;
  onResolve: (id: string, resolved: boolean) => Promise<unknown>;
  onVote: (id: string, value: 1 | -1 | 0) => Promise<unknown>;
}) {
  if (threads.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Line comments">
      {threads.map((t) => (
        <li key={t.root.id}>
          <ThreadItem
            thread={t}
            me={me}
            nameOf={nameOf}
            canWrite={canWrite}
            showPath={showPath}
            onReply={onReply}
            onResolve={onResolve}
            onVote={onVote}
          />
        </li>
      ))}
    </ul>
  );
}

function ThreadItem({
  thread: { root, replies },
  me,
  nameOf,
  canWrite,
  showPath,
  onReply,
  onResolve,
  onVote,
}: {
  thread: LineThread;
  me: string | null;
  nameOf: (userId: string) => string;
  canWrite: boolean;
  showPath: boolean;
  onReply: (parentId: string, body: string) => Promise<unknown>;
  onResolve: (id: string, resolved: boolean) => Promise<unknown>;
  onVote: (id: string, value: 1 | -1 | 0) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const outdated = root.lines === null;
  const resolved = root.resolvedAt !== null;
  const up = root.votes?.up ?? [];
  const down = root.votes?.down ?? [];
  const mine: 1 | -1 | 0 = me && up.includes(me) ? 1 : me && down.includes(me) ? -1 : 0;
  return (
    <article
      className={cn(
        "flex flex-col gap-1 rounded border border-[var(--atlas-border-subtle)] px-2 py-1.5",
        resolved && "opacity-70",
      )}
      aria-label={`Comment by ${nameOf(root.authorId)}`}
    >
      <header className="flex items-center gap-1.5">
        {showPath && root.threadRange && (
          <span className="min-w-0 truncate font-mono text-[var(--muted-foreground)]">{root.threadRange.path}</span>
        )}
        {outdated ? (
          <Badge variant="outline">Outdated</Badge>
        ) : (
          <span className="tabular-nums text-[var(--muted-foreground)]">{linesLabel(root.lines!)}</span>
        )}
        {resolved && <Badge variant="secondary">Resolved</Badge>}
        <span className="ml-auto flex items-center gap-0.5">
          {canWrite && (
            <>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Vote up"
                aria-pressed={mine === 1}
                onClick={() => void onVote(root.id, mine === 1 ? 0 : 1).catch(() => {})}
              >
                <ThumbsUp size={11} /> {up.length > 0 ? up.length : null}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Vote down"
                aria-pressed={mine === -1}
                onClick={() => void onVote(root.id, mine === -1 ? 0 : -1).catch(() => {})}
              >
                <ThumbsDown size={11} /> {down.length > 0 ? down.length : null}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={resolved ? "Reopen" : "Resolve"}
                onClick={() => void onResolve(root.id, !resolved).catch(() => {})}
              >
                {resolved ? <RotateCcw size={11} /> : <Check size={11} />}
              </Button>
            </>
          )}
        </span>
      </header>
      {outdated && root.threadRange && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[var(--atlas-element-hover)] p-1.5 font-mono text-[var(--muted-foreground)]">
          {root.threadRange.quote.replace(/\n$/, "")}
        </pre>
      )}
      <p className="whitespace-pre-wrap text-[var(--foreground)]">
        <span className="font-medium">{nameOf(root.authorId)}</span>{" "}
        {root.body ?? <span className="text-[var(--muted-foreground)]">Comment deleted</span>}
      </p>
      {replies
        .filter((r) => r.body !== null)
        .map((r) => (
          <p key={r.id} className="whitespace-pre-wrap border-l border-[var(--atlas-border-subtle)] pl-2 text-[var(--secondary-foreground)]">
            <span className="font-medium text-[var(--foreground)]">{nameOf(r.authorId)}</span> {r.body}
          </p>
        ))}
      {canWrite && (
        <form
          className="flex items-start gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() === "") return;
            void onReply(root.id, draft.trim())
              .then(() => setDraft(""))
              .catch(() => {});
          }}
        >
          <textarea
            aria-label="Reply"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply…"
            className={TEXTAREA}
          />
          <Button size="xs" variant="outline" type="submit" disabled={draft.trim() === ""}>
            Reply
          </Button>
        </form>
      )}
    </article>
  );
}

/** Where a new comment on selected lines is written. */
export function NewLineComment({
  path,
  lines,
  onSubmit,
  onCancel,
}: {
  path: string;
  lines: LineSpan;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-1.5 rounded border border-[var(--atlas-border-subtle)] p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim() === "") return;
        setBusy(true);
        void onSubmit(body.trim())
          .then(() => {
            setBody("");
            onCancel?.();
          })
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      <span className="flex items-center gap-1.5 text-[var(--secondary-foreground)]">
        <MessageSquarePlus size={11} />
        Comment on {linesLabel(lines).toLowerCase()} of <span className="truncate font-mono">{path}</span>
      </span>
      <textarea
        aria-label="Comment"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className={TEXTAREA}
        autoFocus
      />
      <span className="flex gap-1.5">
        <Button size="xs" type="submit" disabled={busy || body.trim() === ""}>
          Comment
        </Button>
        {onCancel && (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </span>
    </form>
  );
}
