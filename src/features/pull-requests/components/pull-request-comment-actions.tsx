// Edit and delete on a remark the viewer may change: a comment, a line
// comment, or a review's summary. It wraps the remark's body: the pencil and
// the bin sit beside it (shown on hover or focus), the pencil swaps the body
// for the pull-request markdown editor (⌘↵ saves, Escape cancels), and the
// bin asks a second press before anything is deleted.
//
// What may be changed is the host's word per remark (`canEdit`,
// `canDelete`); a review's summary is never deletable. Each row mounts this
// with one line, wrapping the body it already draws.

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Pencil, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";

import { classifyPrError } from "../lib/pr-errors";
import { usePrDeleteCommentMutation, usePrEditCommentMutation } from "../lib/pull-requests-queries";
import type { PrCommentKind } from "../lib/pull-requests-types";
import { useInlineConfirm } from "../lib/use-inline-confirm";
import { readableFailure } from "../lib/use-pull-request-actions";
import { usePullRequestScope } from "./pull-request-context";
import { PullRequestMarkdownEditor } from "./pull-request-markdown";

/** The remark, as much of it as editing needs. */
export interface EditableRemark {
  id: string;
  kind: PrCommentKind;
  body: string;
  canEdit: boolean;
  canDelete: boolean;
}

const NOUN: Record<PrCommentKind, string> = {
  "issue-comment": "comment",
  "review-comment": "comment",
  review: "review summary",
};

export function PullRequestCommentActions({
  comment,
  className,
  children,
}: {
  /** Absent (a history row with no conversation behind it): the body alone. */
  comment: EditableRemark | null | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const { repoPath, number } = usePullRequestScope();
  const edit = usePrEditCommentMutation(repoPath, number);
  const remove = usePrDeleteCommentMutation(repoPath, number);
  const confirm = useInlineConfirm(`comment:${comment?.id ?? ""}`);
  const [editing, setEditing] = useState(false);

  const canEdit = comment?.canEdit === true;
  // GitHub dismisses a review; it never deletes a submitted one.
  const canDelete = comment?.canDelete === true && comment.kind !== "review";
  if (!comment || (!canEdit && !canDelete)) {
    return children ? <div className={className}>{children}</div> : null;
  }
  const noun = NOUN[comment.kind];

  if (editing) {
    return (
      <div className={className}>
        <PullRequestMarkdownEditor
          className="py-1"
          value={comment.body}
          label={`Edit ${noun}`}
          saving={edit.isPending}
          onCancel={() => setEditing(false)}
          onSave={(body) =>
            edit.mutate(
              { commentId: comment.id, kind: comment.kind, body },
              {
                onSuccess: () => setEditing(false),
                onError: (raw) =>
                  toast.error(`Could not save the ${noun}`, {
                    description: readableFailure(
                      classifyPrError(raw),
                      "GitHub refused the change.",
                    ),
                  }),
              },
            )
          }
        />
      </div>
    );
  }

  const armed = confirm.isArmed("delete");
  return (
    <div className={cn("flex items-start gap-1", className)}>
      <div className="min-w-0 flex-1">{children}</div>
      <span
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
          armed || remove.isPending ? "opacity-100" : "opacity-0",
        )}
      >
        {canEdit ? (
          <IconButton
            icon={Pencil}
            label={`Edit ${noun}`}
            size="xs"
            disabled={remove.isPending}
            onClick={() => setEditing(true)}
          />
        ) : null}
        {canDelete ? (
          // One element throughout: the second press must land on the
          // control the first one armed.
          <Button
            size="xs"
            variant={armed ? "destructive" : "ghost"}
            aria-label={armed ? `Confirm delete ${noun}` : `Delete ${noun}`}
            disabled={remove.isPending}
            {...confirm.props("delete", () =>
              remove.mutate(
                { commentId: comment.id, kind: comment.kind },
                {
                  onError: (raw) =>
                    toast.error(`Could not delete the ${noun}`, {
                      description: readableFailure(
                        classifyPrError(raw),
                        "GitHub refused it. Check that the comment is still yours to delete.",
                      ),
                    }),
                },
              ),
            )}
          >
            <Trash2 aria-hidden className="size-3" />
            {remove.isPending ? "Deleting…" : armed ? "Delete?" : null}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
