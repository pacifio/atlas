// Comments on diff lines, sent to the session beside the diff.
//
// The reader picks lines (the gutter's `+`, or a drag down the line numbers)
// and writes in the box that opens under them. "Comment" puts the comment in
// the session's composer as a chip (`review-comments.ts`); from then on the
// composer's draft is its record, and the diff draws every comment the draft
// holds for this diff back under its lines. Removing the chip, or sending,
// takes the annotation away; deleting the annotation takes the chip out.
//
// Performance: one store subscription for the whole panel, which re-renders
// it only when the set of comments in the draft changes. Each file's
// annotations carry a version built from what they show, so the viewer
// re-renders only the file whose comments moved; the render callback and the
// gutter options keep their identity across a keystroke in the box.

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  LineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs";

import {
  linkReviewCommentToComposer,
  newReviewCommentId,
  unlinkReviewComment,
  useComposerReviewComments,
} from "@/features/chat/lib/review-comments";
import type { MentionReviewComment } from "@/features/chat/lib/mentions";
import {
  itemIdOf,
  type DiffAnnotation,
  type DiffAnnotationSource,
} from "../components/diff-viewer/diff-panel-view";
import { DiffCommentAnnotation } from "../components/diff-viewer/diff-comment-annotation";
import { fnv1a32 } from "./diff-rendering";
import {
  buildDiffReviewComment,
  reviewCommentRange,
  type ReviewCommentDraft,
  type ReviewSection,
} from "./review-comment";
import type { ReviewFile } from "./use-review-files";

/** One comment under a line: the box being written, or one in the prompt. */
export interface CommentEntry {
  id: string;
  kind: "draft" | "comment";
  rangeLabel: string;
  text: string;
}

/** What a line's annotation carries: its comments, oldest first. */
export interface CommentGroup {
  comments: CommentEntry[];
}

interface Draft {
  id: string;
  /** The viewer item it is on, and the file's path in the list. */
  itemId: string;
  path: string;
  comment: ReviewCommentDraft;
}

type Selection = { id: string; range: SelectedLineRange } | null;

/** The viewer's side for a range: where its last line is. */
function sideOf(range: SelectedLineRange): "additions" | "deletions" {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

/**
 * Each file's annotations for `comments` (those in this section) and the box
 * being written, keyed by the file's path in the list, with a version per
 * file that moves only when what it shows does.
 */
export function placeReviewComments(
  comments: readonly MentionReviewComment[],
  draft: { path: string; id: string; comment: ReviewCommentDraft } | null,
  pathOf: (comment: MentionReviewComment) => string | null,
): Map<string, { annotations: DiffAnnotation[]; version: string }> {
  const byFile = new Map<string, Map<string, DiffLineAnnotation<CommentGroup>>>();
  const add = (path: string, range: SelectedLineRange, entry: CommentEntry) => {
    let lines = byFile.get(path);
    if (!lines) byFile.set(path, (lines = new Map()));
    const side = sideOf(range);
    const key = `${side}:${range.end}`;
    let annotation = lines.get(key);
    if (!annotation) {
      annotation = { side, lineNumber: range.end, metadata: { comments: [] } };
      lines.set(key, annotation);
    }
    annotation.metadata.comments.push(entry);
  };
  for (const comment of comments) {
    const path = pathOf(comment);
    if (path === null) continue;
    add(path, reviewCommentRange(comment), {
      id: comment.id,
      kind: "comment",
      rangeLabel: comment.rangeLabel,
      text: comment.text,
    });
  }
  if (draft) {
    add(draft.path, reviewCommentRange(draft.comment), {
      id: draft.id,
      kind: "draft",
      rangeLabel: draft.comment.rangeLabel,
      text: "",
    });
  }
  const out = new Map<string, { annotations: DiffAnnotation[]; version: string }>();
  for (const [path, lines] of byFile) {
    const annotations = [...lines.values()];
    const signature = annotations
      .map(
        (a) =>
          `${a.side}:${a.lineNumber}:${a.metadata.comments
            .map((c) => `${c.kind}:${c.id}:${fnv1a32(c.text)}`)
            .join(",")}`,
      )
      .join("|");
    out.set(path, { annotations, version: fnv1a32(signature).toString(36) });
  }
  return out;
}

/**
 * The annotation source for a diff beside a session: its comments, and the
 * gutter that starts one. Null without a session (`chatTabId`): elsewhere the
 * diff has no one to send a comment to, and offers none.
 */
export function useDiffReviewComments({
  chatTabId,
  section,
  files,
  displayPathOf,
}: {
  /** The composer the comments go to; null hides the feature. */
  chatTabId: string | null;
  section: ReviewSection;
  files: readonly ReviewFile[];
  /** The path the agent is told (the file's path in its own root), when not
   *  its path in the list. */
  displayPathOf?: (path: string) => string | undefined;
}): DiffAnnotationSource | null {
  const all = useComposerReviewComments(chatTabId);
  const sectionId = section.id;
  const comments = useMemo(() => all.filter((c) => c.sectionId === sectionId), [all, sectionId]);

  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftText = useRef("");
  const [selectedLines, setSelectedLines] = useState<Selection>(null);
  const setDraft = useCallback((next: Draft | null) => {
    draftText.current = "";
    setDraftState(next);
    if (!next) setSelectedLines(null);
  }, []);
  // A box belongs to one diff: another scope drops it, rather than send a
  // comment on lines no longer on screen.
  const [draftSection, setDraftSection] = useState(sectionId);
  if (draftSection !== sectionId) {
    setDraftSection(sectionId);
    setDraftState(null);
    setSelectedLines(null);
  }

  // The list's path for a comment, which carries the path the agent is told.
  const displayRef = useRef(displayPathOf);
  displayRef.current = displayPathOf;
  const filesRef = useRef(files);
  filesRef.current = files;
  const listPathOf = useMemo(() => {
    const byShown = new Map<string, string>();
    for (const file of files) {
      const path = file.stat.path;
      byShown.set(displayPathOf?.(path) ?? path, path);
    }
    return (comment: MentionReviewComment) => byShown.get(comment.filePath) ?? null;
  }, [files, displayPathOf]);

  const byFile = useMemo(
    () => placeReviewComments(comments, draft, listPathOf),
    [comments, draft, listPathOf],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<unknown> }) => {
      if (!range || context.item.type !== "diff") return;
      const file = filesRef.current.find((f) => itemIdOf(f) === context.item.id);
      if (!file || file.state !== "ready") return;
      const path = file.stat.path;
      const comment = buildDiffReviewComment({
        section: { id: sectionId, title: section.title },
        filePath: displayRef.current?.(path) ?? path,
        fileDiff: file.fileDiff,
        range,
      });
      if (!comment) {
        toast.info("Comments go on the lines the diff shows.");
        return;
      }
      setDraft({ id: newReviewCommentId(), itemId: context.item.id, path, comment });
    },
    [sectionId, section.title, setDraft],
  );

  const deps = { draft, chatTabId, setDraft };
  const renderDeps = useRef(deps);
  renderDeps.current = deps;
  const render = useCallback(
    (
      annotation: LineAnnotation<unknown> | DiffLineAnnotation<unknown>,
      _item: CodeViewItem<unknown>,
    ) => {
      const group = annotation.metadata as CommentGroup | undefined;
      if (!group?.comments?.length) return null;
      return (
        <div className="py-1">
          {group.comments.map((entry) => (
            <DiffCommentAnnotation
              key={entry.id}
              kind={entry.kind}
              rangeLabel={entry.rangeLabel}
              text={entry.kind === "draft" ? draftText.current : entry.text}
              onTextChange={(text) => {
                draftText.current = text;
              }}
              onCancel={() => renderDeps.current.setDraft(null)}
              onComment={(text) => {
                const { draft, chatTabId, setDraft } = renderDeps.current;
                if (!draft || !chatTabId || draft.id !== entry.id) return;
                const mention: MentionReviewComment = { ...draft.comment, id: draft.id, text };
                if (linkReviewCommentToComposer(chatTabId, mention)) setDraft(null);
                else toast.error("The session's composer isn't open, so the comment can't go in.");
              }}
              onDelete={() => {
                const { chatTabId } = renderDeps.current;
                if (chatTabId) unlinkReviewComment(chatTabId, entry.id);
              }}
            />
          ))}
        </div>
      );
    },
    [],
  );

  const options = useMemo(
    () => ({
      enableGutterUtility: draft === null,
      enableLineSelection: draft === null,
      onGutterUtilityClick: beginComment,
      onLineSelectionEnd: beginComment,
    }),
    [draft, beginComment],
  );
  const of = useCallback((file: ReviewFile) => byFile.get(file.stat.path) ?? null, [byFile]);

  const source = useMemo<DiffAnnotationSource>(
    () => ({
      of,
      render,
      options: options as DiffAnnotationSource["options"],
      selectedLines,
      onSelectedLinesChange: setSelectedLines,
    }),
    [of, render, options, selectedLines],
  );
  return chatTabId ? source : null;
}
