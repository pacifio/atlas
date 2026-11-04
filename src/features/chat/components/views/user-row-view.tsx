import { memo, useLayoutEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { CachedMarkdown } from "@/lib/markdown-cache";
import type { UserRow } from "../../lib/turn-rows";
import { userRowMessageId } from "../../lib/turn-rows";
import { M } from "../../lib/row-metrics";
import { UserRowActions } from "../user-row-actions";
import { ImageAttachmentStrip } from "../image-attachments";
import { RemoteAuthor } from "../remote-author";
import { Column } from "./transcript-row-parts";

// ── User ───────────────────────────────────────────────────────────────────

export const UserRowView = memo(function UserRowView({
  row,
  tabId,
  priority,
  justSent = false,
  canRetry = false,
  pinScopeKey,
  fileRoot,
  onToggleExpand,
}: {
  row: UserRow;
  /** Passed rather than read from a store: house rule 3, and a primitive prop
   *  keeps the shallow-compare `memo` above intact. */
  tabId: string;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
  /** True ONLY for the message the user sent just now (id-scoped in the
   *  store). The previous wall-clock-vs-timestamp gate animated entire
   *  restored threads (resume/replay paths stamp messages "now") and every
   *  row mounted during an early scroll — bulk entrance animations during
   *  fast scroll were a blanking contributor. */
  justSent?: boolean;
  /** True only for the thread's last user message on an agent that can rewind.
   *  Resolved by the transcript so this stays a boolean — a callback minted in
   *  the row map would defeat the memo for every row on every frame. */
  canRetry?: boolean;
  /** Pin scope for this thread — resolved once by the transcript. */
  pinScopeKey: string;
  /** The session's project root: `@file` chips open what they name. */
  fileRoot?: string;
  onToggleExpand: (id: string) => void;
}) {
  const clampRef = useRef<HTMLDivElement>(null);
  const { height: clampHeight, overflows } = useWholeLineClamp(clampRef, !row.expanded);
  const messageId = userRowMessageId(row.id);
  return (
    // Generous space BELOW the prompt: the gap is what separates one exchange
    // from the next, and a tight one made the agent's reply read as a
    // continuation of the user's own message.
    // `pb-7` (28px) is not slack, it is the action bar's room: the bar is
    // absolutely positioned at `top-full`, so its 8px top pad and 20px icons
    // have to fit under the bubble or a hovered row overhangs into the agent's
    // reply. Reserved statically for EVERY user row — hovered or not, with an
    // expand toggle or without — so revealing the bar can never move anything
    // (house rule 1).
    <Column className="flex justify-end pt-6 pb-7">
      {/* `min-w-0` on both flex levels, `max-w-full` on the bubble: a pasted
          code block is `white-space: pre` (unwrappable), and a flex item's
          automatic minimum size floors at that intrinsic width — the pre's own
          `overflow-x: auto` cannot save an ancestor that refuses to shrink, so
          a long paste dragged the whole bubble past the viewport edge. With
          the chain capped, the fence scrolls horizontally INSIDE the bubble. */}
      <div className="relative flex min-w-0 max-w-[80%] flex-col items-end">
        {/* Images above the bubble, right-aligned with it — the same tiles
            the composer showed before send. */}
        <ImageAttachmentStrip images={row.attachments} className="mb-2 justify-end" />
        {/* The prompt is markdown too. It is written in the same composer that
            accepts fences and lists, and rendering it as flat text collapsed
            every newline — a pasted snippet came back as one run-on paragraph.
            Same renderer as the agent's prose so a quoted block looks identical
            on both sides of the thread; only the type scale differs.

            Clamped by HEIGHT rather than `-webkit-line-clamp`: line-clamp needs
            inline content, and the moment the bubble holds block elements
            (paragraphs, a list, a fence) it stops clamping at all. */}
        <div
          // A row a comment can hang off (`response-selection.ts`): the
          // selection pill and a click on the prose read the key here.
          data-comment-anchor={messageId}
          className={cn(
            // Apple-squircle read: one big continuous radius (no clipped
            // corner), a touch more padding — iMessage-adjacent geometry.
            // A fixed 20px, NOT `rounded-full`: this bubble grows to many
            // lines, and a radius of half its height turns it into an ellipse
            // whose curve cuts off the first and last line at the corners.
            // ratchet-allow: 20px sits above the `rounded-*` scale (xl = 12px), and
            // a full radius clips multi-line bubbles.
            "min-w-0 max-w-full rounded-[20px] bg-primary-muted px-4 py-2.5 select-text",
            // Entrance only for THE message sent just now (id-scoped).
            justSent && "atlas-bubble-in",
          )}
        >
          {/* The clamp lives INSIDE the padding, not on the bubble: the bubble
              is border-box, so a `max-height` there spent 20px of the budget
              on padding and sliced the last line in half — and `overflow`
              clips at the padding edge, so the cut line bled into the bottom
              padding instead of stopping above it. Here the budget is pure
              line boxes and the bubble's own padding stays clear. */}
          <div
            ref={clampRef}
            style={row.expanded ? undefined : { maxHeight: clampHeight, overflow: "hidden" }}
          >
            {/* The prose classes go on the markdown root itself, as they do
                for the agent's prose: the block rules are `> *` selectors, and
                on the bubble they matched this wrapper instead of the
                paragraphs, so a multi-paragraph prompt rendered with no gaps
                at all. `prose-session-user` is the bubble's step up the type
                scale (22px lines, `row-metrics.ts`). */}
            <CachedMarkdown
              source={row.text}
              codeActions={null}
              priority={priority}
              fileRoot={fileRoot}
              trustedPaths={row.trustedPaths}
              className="prose-session-user"
            />
          </div>
        </div>
        {row.contextBlocks > 0 && (
          <button
            type="button"
            className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground hover:text-secondary-foreground cursor-pointer transition-colors"
            title="Context attached with @-mentions"
          >
            <Paperclip size={10} />
            {row.contextBlocks} attached
          </button>
        )}
        {/* A prompt sent by whoever held the remote-control seat, not this
            window: the thread names them, the same caption row as the
            attached-context chip. Only the live row knows — a snapshot
            carries no origin, so after a reload the caption is gone. */}
        {row.remoteAuthor && (
          <RemoteAuthor tabId={tabId} id={row.remoteAuthorId} fallback={row.remoteAuthor} />
        )}
        {overflows && <ExpandToggle row={row} onToggleExpand={onToggleExpand} />}
        <UserRowActions
          tabId={tabId}
          text={row.text}
          canRetry={canRetry}
          messageId={messageId}
          timestamp={row.timestamp}
          timestampApproximate={row.timestampApproximate === true}
          pinScopeKey={pinScopeKey}
          toggleAbove={overflows}
        />
      </div>
    </Column>
  );
});

/** The clamp budget: `userMaxLines` lines of bubble text. */
const USER_CLAMP_PX = M.userMaxLines * M.userLineHeight;

/**
 * The collapsed bubble's `max-height`, snapped down to the bottom of the last
 * line that fits whole inside `USER_CLAMP_PX`.
 *
 * The budget alone is only exact for one unbroken paragraph. Paragraph gaps,
 * list spacing and a fence's own line height all knock later lines off the
 * 22px grid, so a fixed cut lands mid-glyph on most real prompts. Measured,
 * not predicted: only the block that straddles the cut is read line by line,
 * and a prompt short enough to fit costs one `scrollHeight` read.
 *
 * Also reports whether the prompt overflows the budget at all, which is what
 * decides the "Show more" toggle. That used to be a character-count guess, and
 * a 300-character prompt that wraps to four lines got a toggle that did
 * nothing. The markdown root's `scrollHeight` is its natural height whether or
 * not the wrapper is clamping it, so the answer holds while expanded too.
 *
 * Re-measured on resize of the markdown root, which covers both a width change
 * (the lines rewrap) and the raw-source placeholder swapping to parsed HTML.
 */
function useWholeLineClamp(
  ref: React.RefObject<HTMLDivElement | null>,
  active: boolean,
): { height: number; overflows: boolean } {
  const [height, setHeight] = useState(USER_CLAMP_PX);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current?.firstElementChild;
    if (!(root instanceof HTMLElement)) return;
    const measure = () => {
      const over = root.scrollHeight > USER_CLAMP_PX;
      setOverflows(over);
      if (!active) return;
      if (!over) {
        setHeight(USER_CLAMP_PX);
        return;
      }
      const base = root.getBoundingClientRect().top;
      let fit = 0;
      for (const child of Array.from(root.children)) {
        const box = child.getBoundingClientRect();
        if (box.top - base >= USER_CLAMP_PX) break;
        if (box.bottom - base <= USER_CLAMP_PX) {
          fit = box.bottom - base;
          continue;
        }
        // The block the cut falls inside: keep its last whole line.
        const range = document.createRange();
        range.selectNodeContents(child);
        for (const line of Array.from(range.getClientRects())) {
          const bottom = line.bottom - base;
          if (bottom <= USER_CLAMP_PX && bottom > fit) fit = bottom;
        }
        break;
      }
      setHeight(fit > 0 ? Math.ceil(fit) : USER_CLAMP_PX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [ref, active]);
  return { height, overflows };
}

/**
 * "Show more" / "Show less". The row renders it only when the prompt measurably
 * overflows the clamp (`useWholeLineClamp`).
 *
 * In flow and always visible, unlike the action bar beneath it. That is
 * deliberate: this one is not an action on the message, it is the only way to
 * know the bubble is truncated at all. Hiding it until hover would mean a
 * clamped prompt looks like a complete one.
 */
function ExpandToggle({
  row,
  onToggleExpand,
}: {
  row: UserRow;
  onToggleExpand: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggleExpand(row.id)}
      className="mt-0.5 h-control-2xs text-2xs text-muted-foreground hover:text-secondary-foreground cursor-pointer transition-colors"
    >
      {row.expanded ? "Show less" : "Show more"}
    </button>
  );
}
