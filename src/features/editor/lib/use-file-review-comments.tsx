// Comments on a file's lines, sent to the session — the file view's side of
// the diff's line comments (`use-diff-review-comments.tsx`).
//
// The gutter's `+` beside a line number (or a drag down the numbers) opens a
// box under those lines; "Comment" puts the comment in the session's composer
// as a chip, quoting the lines. The composer's draft is the record from then
// on, and the file view draws the comments it holds for this file back under
// their lines.
//
// The file is editable, so a comment's lines can move under it. The editor
// carries the annotations through an edit and hands them back moved; the
// view keeps where each one now sits (`moved`) so it stays on its lines. The
// chip keeps the lines as they were when the comment was written: those are
// the lines the comment is about.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";

import type { MentionReviewComment } from "@/features/chat/lib/mentions";
import {
  linkReviewCommentToComposer,
  newReviewCommentId,
  unlinkReviewComment,
  useComposerReviewComments,
} from "@/features/chat/lib/review-comments";
import { DiffCommentAnnotation } from "@/features/git/components/diff-viewer/diff-comment-annotation";
import { buildFileReviewComment, formatFileRange } from "@/features/git/lib/review-comment";

/** One comment under a line of the file. */
export interface FileCommentEntry {
  id: string;
  kind: "draft" | "comment";
  startLine: number;
  endLine: number;
  text: string;
}

/** What a line's annotation carries. */
export interface FileCommentGroup {
  entries: FileCommentEntry[];
}

export type FileCommentLineAnnotation = LineAnnotation<FileCommentGroup>;

/** What `CodeFileView` is handed to draw comments and start one. */
export interface FileCommentsBinding {
  lineAnnotations: FileCommentLineAnnotation[];
  renderAnnotation: (annotation: FileCommentLineAnnotation) => ReactNode;
  /** A box is open: the gutter's `+` and line picking are off until it closes. */
  writing: boolean;
  begin: (range: SelectedLineRange) => void;
  /** The editor moved annotations through an edit. */
  onMoved: (next: FileCommentLineAnnotation[]) => void;
}

/** The lines a range covers, low to high. */
export function normalizeFileCommentRange(range: SelectedLineRange): {
  startLine: number;
  endLine: number;
} {
  return { startLine: Math.min(range.start, range.end), endLine: Math.max(range.start, range.end) };
}

/** Each entry kept on the line the editor moved its annotation to, its span
 *  unchanged: an annotation sits under its last line. */
export function remapFileCommentAnnotations(
  annotations: readonly FileCommentLineAnnotation[],
): FileCommentLineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((entry) => {
        const span = entry.endLine - entry.startLine;
        return {
          ...entry,
          endLine: annotation.lineNumber,
          startLine: Math.max(1, annotation.lineNumber - span),
        };
      }),
    },
  }));
}

/** The file's annotations: the comments in the draft for it, each where an
 *  edit last moved it or else where it was written, and the open box. */
export function placeFileComments(
  comments: readonly MentionReviewComment[],
  moved: ReadonlyMap<string, { startLine: number; endLine: number }>,
  draft: FileCommentEntry | null,
): FileCommentLineAnnotation[] {
  const byLine = new Map<number, FileCommentLineAnnotation>();
  const add = (entry: FileCommentEntry) => {
    let annotation = byLine.get(entry.endLine);
    if (!annotation) {
      annotation = { lineNumber: entry.endLine, metadata: { entries: [] } };
      byLine.set(entry.endLine, annotation);
    }
    annotation.metadata.entries.push(entry);
  };
  for (const comment of comments) {
    const at = moved.get(comment.id) ?? { startLine: comment.start, endLine: comment.end };
    add({ id: comment.id, kind: "comment", ...at, text: comment.text });
  }
  if (draft) add(draft);
  return [...byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber);
}

/**
 * The comment binding for a file view whose session composer is `chatTabId`;
 * null without one, which leaves the view with no gutter `+`.
 */
export function useFileReviewComments({
  chatTabId,
  absPath,
  filePath,
  getContents,
}: {
  chatTabId: string | null;
  /** The file on disk: the comments' section is `file:<absPath>`. */
  absPath: string;
  /** The path the agent is told: root-relative when the file is in one. */
  filePath: string;
  /** The document as it is now, for the quoted lines. */
  getContents: () => string;
}): FileCommentsBinding | null {
  const sectionId = `file:${absPath}`;
  const all = useComposerReviewComments(chatTabId);
  const comments = useMemo(() => all.filter((c) => c.sectionId === sectionId), [all, sectionId]);
  const [draft, setDraft] = useState<FileCommentEntry | null>(null);
  const [moved, setMoved] = useState<ReadonlyMap<string, { startLine: number; endLine: number }>>(
    () => new Map(),
  );
  const draftText = useRef("");

  const lineAnnotations = useMemo(
    () => placeFileComments(comments, moved, draft),
    [comments, moved, draft],
  );
  const placed = useRef(lineAnnotations);
  placed.current = lineAnnotations;

  const onMoved = useCallback((next: FileCommentLineAnnotation[]) => {
    // The editor hands back the array it was given until an edit moves one.
    if (next === placed.current) return;
    const remapped = remapFileCommentAnnotations(next);
    const at = new Map<string, { startLine: number; endLine: number }>();
    let movedDraft: FileCommentEntry | null = null;
    for (const annotation of remapped) {
      for (const entry of annotation.metadata.entries) {
        if (entry.kind === "draft") movedDraft = entry;
        else at.set(entry.id, { startLine: entry.startLine, endLine: entry.endLine });
      }
    }
    setMoved(at);
    if (movedDraft) setDraft(movedDraft);
  }, []);

  const begin = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    draftText.current = "";
    setDraft({ id: newReviewCommentId(), kind: "draft", startLine, endLine, text: "" });
  }, []);

  const deps = { draft, chatTabId, filePath, sectionId, getContents };
  const latest = useRef(deps);
  latest.current = deps;
  const renderAnnotation = useCallback(
    (annotation: FileCommentLineAnnotation) => (
      <div className="py-1">
        {annotation.metadata.entries.map((entry) => (
          <DiffCommentAnnotation
            key={entry.id}
            kind={entry.kind}
            rangeLabel={formatFileRange(entry.startLine, entry.endLine)}
            text={entry.kind === "draft" ? draftText.current : entry.text}
            onTextChange={(text) => {
              draftText.current = text;
            }}
            onCancel={() => setDraft(null)}
            onComment={(text) => {
              const { draft, chatTabId, filePath, sectionId, getContents } = latest.current;
              if (!draft || !chatTabId || draft.id !== entry.id) return;
              const comment = buildFileReviewComment({
                section: { id: sectionId, title: "File" },
                filePath,
                startLine: draft.startLine,
                endLine: draft.endLine,
                contents: getContents(),
              });
              const mention: MentionReviewComment = { ...comment, id: draft.id, text };
              if (linkReviewCommentToComposer(chatTabId, mention)) setDraft(null);
              else toast.error("The session's composer isn't open, so the comment can't go in.");
            }}
            onDelete={() => {
              const { chatTabId } = latest.current;
              if (chatTabId) unlinkReviewComment(chatTabId, entry.id);
            }}
          />
        ))}
      </div>
    ),
    [],
  );

  const binding = useMemo<FileCommentsBinding>(
    () => ({ lineAnnotations, renderAnnotation, writing: draft !== null, begin, onMoved }),
    [lineAnnotations, renderAnnotation, draft, begin, onMoved],
  );
  return chatTabId ? binding : null;
}
