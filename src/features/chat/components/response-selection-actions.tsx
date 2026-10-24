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
} from "../stores/chat-comments-store";
import { actionPosition, responseAt, selectedResponse } from "../lib/response-selection";

/** One pill for both actions — the CommentButton takes it as its className,
 *  so its height, padding and radius cannot drift from Cite's. */
const PILL_BUTTON =
  "flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] [&_svg]:shrink-0";

interface Target {
  response: HTMLElement;
  messageId: string;
  text: string | null;
  anchor: { x: number; top: number; bottom: number };
}

/** One delegated controller per visible transcript, rather than document
 * listeners or pointer-driven React renders on every response row. */
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
      const selected = selectedResponse(window.getSelection(), viewport);
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
        response: selected.response,
        messageId: selected.response.dataset.agentResponse!,
        text: selected.text,
        anchor: { x: rect.left, top: rect.top, bottom: rect.bottom },
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
    const move = (event: PointerEvent) => {
      if (
        event.pointerType === "touch" ||
        event.buttons ||
        openRef.current ||
        (targetRef.current?.text !== null && targetRef.current?.text !== undefined)
      )
        return;
      if (toolbarRef.current?.contains(event.target as Node)) return;
      const response = responseAt(event.target as Node, viewport);
      if (!response) {
        setTarget(null);
        return;
      }
      // A stationary button is easier to hit than one chasing every pointer
      // pixel. Move it only after the reader moves to another line/response.
      const prev = targetRef.current;
      if (prev?.response === response && Math.abs(event.clientY - prev.anchor.top) < 32) return;
      setTarget({
        response,
        messageId: response.dataset.agentResponse!,
        text: null,
        anchor: { x: event.clientX + 12, top: event.clientY, bottom: event.clientY + 4 },
      });
    };
    const leave = (event: PointerEvent) => {
      if (toolbarRef.current?.contains(event.relatedTarget as Node)) return;
      if (
        !targetRef.current?.text &&
        !openRef.current &&
        !toolbarRef.current?.contains(document.activeElement)
      )
        setTarget(null);
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
        targetRef.current?.text &&
        !toolbarRef.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        toolbarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    const observer = new MutationObserver(() => {
      if (
        targetRef.current &&
        (!viewport.contains(targetRef.current.response) ||
          targetRef.current.response.dataset.agentResponse !== targetRef.current.messageId)
      )
        dismiss();
    });
    observer.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-agent-response"],
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
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerleave", leave);
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
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerleave", leave);
      viewport.removeEventListener("scroll", layoutDismiss, true);
      window.removeEventListener("resize", layoutDismiss);
      window.removeEventListener("blur", layoutDismiss);
      openRef.current = false;
    };
  }, [enabled, viewportRef]);

  if (!enabled || !target) return null;
  return (
    <SelectionToolbar
      key={`${tabId}:${target.messageId}:${target.text ?? ""}`}
      target={target}
      tabId={tabId}
      viewportRef={viewportRef}
      toolbarRef={toolbarRef}
      onOpenChange={(open) => {
        openRef.current = open;
        if (!open) setTarget(null);
      }}
      onPointerLeave={(event) => {
        if (
          !openRef.current &&
          targetRef.current?.text === null &&
          !viewportRef.current?.contains(event.relatedTarget as Node)
        )
          setTarget(null);
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
  onPointerLeave,
}: {
  target: Target;
  tabId: string;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onPointerLeave: React.PointerEventHandler<HTMLDivElement>;
}) {
  const hit = useAnchorHit(tabId, target.messageId);
  const comments = useCommentBucket(tabId, target.messageId);
  const actions = useCommentActions(tabId);
  const directory = useCommentDirectory(tabId);
  const canComment = !!(hit && actions && directory);
  const [citing, setCiting] = useState(false);
  const changeCiting = (open: boolean) => {
    setCiting(open);
    onOpenChange(open);
  };
  // The note field, focused without scrolling: the popup is portalled to the
  // end of `body` and gets focus before it is positioned (the same reason
  // `CommentButton` focuses its own popup this way).
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
        target.anchor,
        { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
      ),
    );
  }, [target, viewportRef, toolbarRef, canComment]);
  if (!target.text && !canComment) return null;
  return (
    <div
      ref={toolbarRef}
      role="group"
      aria-label={target.text ? "Selected response actions" : "Response actions"}
      // The house floating pill: the background fill under the menu-rung
      // shadow and the inset top highlight. Fully round, and the two buttons
      // inside are the same round pill at the same height with the same 12px
      // icon, so neither reads as the odd one out.
      className={cn(
        "absolute z-popover flex max-w-full items-center gap-0.5 rounded-full p-1",
        // Opaque, no blur: a live backdrop blur under a pill that follows the
        // selection repaints on every move, and the surface reads fine solid.
        "border border-[var(--atlas-element-active)] bg-[var(--background)]",
        "inset-highlight shadow-md text-foreground atlas-pill-in",
      )}
      style={position}
      onPointerLeave={onPointerLeave}
      // Keep the selection while the pill is pressed. Only the pill's own
      // DOM: React bubbles a portalled popover's events through here too, and
      // preventing those would stop a click placing the caret in its field.
      onMouseDown={(event) => {
        if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
      }}
    >
      {target.text !== null && (
        <Popover open={citing} onOpenChange={changeCiting}>
          {/* The bare trigger wearing the pill's button, as `CommentButton`
              does, so Cite and Comment stay one shape. */}
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
                  messageId={target.messageId}
                  rowId={hit?.rowId ?? null}
                  tabId={tabId}
                  share={citeShareTarget(hit, actions, directory)}
                  onDone={() => changeCiting(false)}
                />
              </div>
            </PopoverContent>
          )}
        </Popover>
      )}
      {/* A shared session keeps Comment beside Cite: it is also the reply's
          thread (read, reply, resolve), and the way to comment on a passage
          without pointing the agent at it. An unshared session has nothing to
          comment on, so the pill is Cite alone. */}
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
          selectedText={target.text ?? undefined}
          onOpenChange={onOpenChange}
          collisionBoundary={viewportRef.current ?? undefined}
        />
      )}
    </div>
  );
}
