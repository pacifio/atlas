import { useLayoutEffect, useRef, useState } from "react";
import { MessageSquareCode, Trash2 } from "lucide-react";

import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { isMac } from "@/lib/platform";
import { isCommentSubmitShortcut } from "../../lib/comment-submit-shortcut";

/**
 * A comment drawn under the lines it is on, in the diff or the file view: the
 * box one is written in (`draft`), or one already in the session's prompt
 * (`comment`), with a delete that takes it back out.
 *
 * The box keeps its own text: the viewer re-renders an annotation only when
 * its item's version changes, so a keystroke must not have to travel through
 * the panel to reach it. `onTextChange` lets the panel remember the text
 * (a scroll that unmounts the row brings it back as it was).
 */

const stop = (event: React.PointerEvent) => event.stopPropagation();

const TEXTAREA_CLASS =
  "block w-full min-w-0 resize-y rounded border border-border bg-panel-input px-2 py-1.5 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-border-strong";

export function DiffCommentAnnotation({
  kind,
  rangeLabel,
  text,
  onTextChange,
  onCancel,
  onComment,
  onDelete,
}: {
  kind: "draft" | "comment";
  /** `+12 to +14`, `L3`: for the box's name. */
  rangeLabel: string;
  /** The comment's text, or the draft's as it was left. */
  text: string;
  onTextChange?: (text: string) => void;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const body = draft.trim();

  // Focused a frame after mount, without scrolling: the viewer is still
  // laying the row out, and a scroll now would land on its old height.
  useLayoutEffect(() => {
    if (kind !== "draft") return;
    const frame = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [kind]);

  if (kind === "comment") {
    return (
      <div
        data-diff-comment-annotation="comment"
        className="group/comment mx-3 my-1.5 flex min-w-0 items-start gap-2 rounded-md border border-border border-s-primary bg-background px-3 py-2 font-sans text-foreground"
        contentEditable={false}
        onPointerDown={stop}
      >
        <MessageSquareCode aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {rangeLabel} · in your next prompt
          </p>
        </div>
        {onDelete ? (
          <span className="flex shrink-0 opacity-0 transition-opacity duration-fast group-hover/comment:opacity-100 focus-within:opacity-100">
            <IconButton size="xs" icon={Trash2} label="Delete comment" onClick={onDelete} />
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-diff-comment-annotation="draft"
      className="px-3 py-2 font-sans"
      contentEditable={false}
      onPointerDown={stop}
    >
      <textarea
        ref={textareaRef}
        rows={3}
        value={draft}
        placeholder="Comment for the agent"
        aria-label={`Comment on lines ${rangeLabel}`}
        className={TEXTAREA_CLASS}
        onChange={(event) => {
          setDraft(event.target.value);
          onTextChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (
            isCommentSubmitShortcut(
              {
                key: event.key,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                repeat: event.repeat,
                isComposing: event.nativeEvent.isComposing,
              },
              draft,
            )
          ) {
            event.preventDefault();
            onComment(body);
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-2xs text-muted-foreground">
          {isMac ? "⌘↵" : "Ctrl+↵"} adds it to the session's prompt
        </span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!body} onClick={() => onComment(body)}>
          Comment
        </Button>
      </div>
    </div>
  );
}
