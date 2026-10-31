import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Quote } from "lucide-react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Popover, PopoverContent } from "@/ui/popover";
import { CommentButton } from "@/features/artifacts/components/comment-thread";
import { cn } from "@/lib/utils";
import { CiteForm, citeShareTarget } from "./cite-popover";
import {
  useAnchorHit,
  useCommentActions,
  useCommentBucket,
  useCommentDirectory,
  useHasCloudTarget,
} from "../stores/chat-comments-store";
import { actionPosition, chatKeyOf, isCitable, selectedAnchor } from "../lib/response-selection";

/** One pill for both actions, so their height, padding and radius cannot
 *  drift apart. The design system's pill: control-xs tall, 2xs type,
 *  secondary ink that comes up to the foreground on hover, a 12px glyph. */
const PILL_BUTTON =
  "flex h-control-xs shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-2xs font-medium text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3 [&_svg]:shrink-0";

interface Target {
  anchor: HTMLElement;
  chatKey: string;
  /** The selection, as selected. */
  text: string;
  citable: boolean;
  position: { x: number; top: number; bottom: number };
}

/**
 * One delegated controller per visible transcript, rather than document
 * listeners or pointer-driven React renders on every row.
 *
 * A selection on a prompt or a response brings the pill: Cite (a response
 * only — it points the agent at its own words) and Comment, the Timeline's
 * thread popover grown out of the pill, about the selected passage. A plain
 * click on the prose starts nothing: comments open in a popover, not in the
 * transcript.
 *
 * The pill answers a selection and nothing else. It used to follow the
 * pointer over prose as well; that read as chrome chasing the cursor.
 */
export function ResponseSelectionActions({
  viewportRef,
  tabId,
  enabled,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  tabId: string;
  enabled: boolean;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) {
      setTarget(null);
      return;
    }
    let frame = 0;
    let selecting = false;
    // Clicking non-selectable chrome (sidebar, gutters) leaves the selection
    // intact, so the next pointerup would read it and bring the toolbar back.
    // A dismissed selection stays dismissed until the selection changes.
    let dismissed = false;
    const dismiss = () => {
      openRef.current = false;
      dismissed = true;
      setTarget(null);
    };
    // Layout moved under the pill (a scroll, a resize, the window losing
    // focus). With a popover open, its draft matters more than the pill's
    // position: the popover stays, anchored to the pill, and owns its close.
    const layoutDismiss = () => {
      if (!openRef.current) dismiss();
    };
    const readSelection = () => {
      if (
        dismissed ||
        selecting ||
        openRef.current ||
        toolbarRef.current?.contains(document.activeElement)
      )
        return;
      const selected = selectedAnchor(window.getSelection(), viewport);
      if (!selected) {
        setTarget(null);
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      const rects = Array.from(selected.range.getClientRects());
      const visibleRects = rects.filter((r) => r.bottom > bounds.top && r.top < bounds.bottom);
      const rect = visibleRects[visibleRects.length - 1];
      if (!rect) {
        setTarget(null);
        return;
      }
      setTarget({
        anchor: selected.anchor,
        chatKey: chatKeyOf(selected.anchor),
        text: selected.text,
        citable: isCitable(selected.anchor),
        position: { x: rect.left, top: rect.top, bottom: rect.bottom },
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readSelection);
    };
    const selectionChange = () => {
      dismissed = false;
      schedule();
    };
    const focus = (event: FocusEvent) => {
      if (!openRef.current && !toolbarRef.current?.contains(event.target as Node)) dismiss();
    };
    const pointerDown = (event: PointerEvent) => {
      selecting = viewport.contains(event.target as Node);
      if (!openRef.current && !toolbarRef.current?.contains(event.target as Node)) dismiss();
    };
    const pointerUp = () => {
      selecting = false;
      schedule();
    };
    const pointerCancel = () => {
      selecting = false;
      dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (openRef.current) return; // An open popover owns its focus and Escape.
      if (event.key === "Escape" && targetRef.current) {
        event.preventDefault();
        dismiss();
      } else if (
        event.key === "Tab" &&
        !event.shiftKey &&
        targetRef.current &&
        !toolbarRef.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        toolbarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    const observer = new MutationObserver(() => {
      if (
        targetRef.current &&
        (!viewport.contains(targetRef.current.anchor) ||
          targetRef.current.anchor.dataset.commentAnchor !== targetRef.current.chatKey)
      )
        dismiss();
    });
    observer.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-comment-anchor"],
    });
    // Split-pane and sidebar resizes need not resize the window itself.
    // Ignore ResizeObserver's initial delivery so a new selection survives.
    let width = viewport.clientWidth,
      height = viewport.clientHeight;
    const resizeObserver = new ResizeObserver(() => {
      if (viewport.clientWidth !== width || viewport.clientHeight !== height) {
        width = viewport.clientWidth;
        height = viewport.clientHeight;
        layoutDismiss();
      }
    });
    resizeObserver.observe(viewport);
    document.addEventListener("selectionchange", selectionChange);
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerCancel);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", key);
    viewport.addEventListener("scroll", layoutDismiss, true);
    window.addEventListener("resize", layoutDismiss);
    window.addEventListener("blur", layoutDismiss);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("selectionchange", selectionChange);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", pointerCancel);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", key);
      viewport.removeEventListener("scroll", layoutDismiss, true);
      window.removeEventListener("resize", layoutDismiss);
      window.removeEventListener("blur", layoutDismiss);
      openRef.current = false;
    };
  }, [enabled, viewportRef, tabId]);

  if (!enabled || !target) return null;
  return (
    <SelectionToolbar
      key={`${tabId}:${target.chatKey}:${target.text}`}
      target={target}
      tabId={tabId}
      viewportRef={viewportRef}
      toolbarRef={toolbarRef}
      onOpenChange={(open) => {
        openRef.current = open;
        if (!open) setTarget(null);
      }}
    />
  );
}

function SelectionToolbar({
  target,
  tabId,
  viewportRef,
  toolbarRef,
  onOpenChange,
}: {
  target: Target;
  tabId: string;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  const hit = useAnchorHit(tabId, target.chatKey);
  const actions = useCommentActions(tabId);
  const directory = useCommentDirectory(tabId);
  const cloud = useHasCloudTarget(tabId);
  const comments = useCommentBucket(tabId, target.chatKey);
  const canComment = !!(hit && actions && directory);
  const [citing, setCiting] = useState(false);
  const changeCiting = (open: boolean) => {
    setCiting(open);
    onOpenChange(open);
  };
  // The note field, focused without scrolling: the popup is portalled to the
  // end of `body` and gets focus before it is positioned.
  const focusNote = useCallback((openType: string) => {
    if (openType === "touch") return true;
    const field = document.querySelector<HTMLTextAreaElement>("[data-cite-note] textarea");
    field?.focus({ preventScroll: true });
    return false;
  }, []);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const viewport = viewportRef.current,
      toolbar = toolbarRef.current;
    if (!viewport || !toolbar) return;
    const bounds = viewport.getBoundingClientRect();
    setPosition(
      actionPosition(
        bounds,
        {
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          offsetWidth: viewport.offsetWidth,
          offsetHeight: viewport.offsetHeight,
        },
        target.position,
        { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
      ),
    );
  }, [target, viewportRef, toolbarRef, canComment]);
  if (!target.citable && !canComment) return null;
  return (
    <div
      ref={toolbarRef}
      role="group"
      aria-label="Selected response actions"
      // The design system's floating pill: a card surface on a hairline
      // border, the menu-rung shadow for lift, fully round. The buttons
      // inside are the same round pill at the same height with the same 12px
      // glyph, so neither reads as the odd one out.
      className={cn(
        "absolute z-popover flex max-w-full items-center gap-0.5 rounded-full p-0.5",
        // Opaque, no blur: a live backdrop blur under a pill that follows the
        // selection repaints on every move, and the surface reads fine solid.
        "border border-border bg-card shadow-md text-foreground atlas-pill-in",
      )}
      style={position}
      // Keep the selection while the pill is pressed. Only the pill's own
      // DOM: React bubbles a portalled popover's events through here too, and
      // preventing those would stop a click placing the caret in its field.
      onMouseDown={(event) => {
        if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
      }}
    >
      {target.citable && (
        <Popover open={citing} onOpenChange={changeCiting}>
          <PopoverPrimitive.Trigger className={PILL_BUTTON}>
            <Quote size={12} strokeWidth={1.7} />
            Cite
          </PopoverPrimitive.Trigger>
          {/* Mounted only while open: a selection that is never cited costs
              nothing past the pill, and the transcript never re-renders for
              any of it (this toolbar owns its own state). */}
          {citing && (
            <PopoverContent side="bottom" align="start" sideOffset={6} initialFocus={focusNote}>
              <div data-cite-note>
                <CiteForm
                  text={target.text}
                  messageId={target.chatKey}
                  rowId={hit?.rowId ?? null}
                  tabId={tabId}
                  // "Share with team" is for a session the team can see.
                  share={cloud ? citeShareTarget(hit, actions, directory) : null}
                  onDone={() => changeCiting(false)}
                />
              </div>
            </PopoverContent>
          )}
        </Popover>
      )}
      {/* The Timeline's thread popover, grown out of the pill: the passage
          quoted, the thread, Reply and Resolve — the row's discussion,
          without the transcript growing a block for it. */}
      {canComment && (
        <CommentButton
          bare
          showLabel
          className={cn(PILL_BUTTON, "opacity-100 transition-none")}
          anchorKind={hit!.anchorKind}
          anchorId={hit!.rowId}
          comments={comments}
          actions={actions!}
          directory={directory!}
          selectedText={target.text}
          onOpenChange={onOpenChange}
          collisionBoundary={viewportRef.current ?? undefined}
        />
      )}
    </div>
  );
}
