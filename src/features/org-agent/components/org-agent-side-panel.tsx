// The Organisation agent at home: the side panel (the surfaces pane's
// `agent-panel` tab), beside the session. Its conversations are tabs along
// the top, in the terminal's tab strip (`terminal-tab-strip.tsx`) at the
// title bar's height, with New, Minimise and Full screen beside them. History
// is the full page's.
//
// A conversation is shown in one place at a time (`org-agent-store.ts`):
//   - here, by default;
//   - Minimise sends it to the floating messenger, and this panel says so
//     instead of drawing it twice — Bring it back returns it;
//   - Full screen sends it to the full page, and the same.

import { useTipOnMount } from "@/features/tips/lib/use-tip-on-mount";
import { useEffect, useRef } from "react";
import { Maximize2, MessageSquare, Minus, PictureInPicture2, Plus, X } from "lucide-react";

import { fadeMask } from "@/features/layout/components/pane-tab-strip";
import { revealAgentPage } from "@/features/layout/lib/org-agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useStripEdges } from "@/features/terminal/components/terminal-tab-strip";
import { cn } from "@/lib/utils";

import { askBusy, askTitle, askWaiting, useOrgAgentStore } from "../stores/org-agent-store";
import { OrgAgentThread } from "./org-agent-thread";
import { GradualBlur, HintGroup, HintItem, IconButton } from "@tryatlas/design";

export function OrgAgentSidePanel() {
  useTipOnMount("ask-atlas");
  const activeId = useOrgAgentStore.use.activeId();
  const floatingId = useOrgAgentStore.use.floatingId();
  const pageId = useOrgAgentStore.use.pageId();
  const { newChat } = useOrgAgentStore.use.actions();
  const active = activeId;

  // Opened with nothing in it: a fresh conversation, so the panel never
  // opens onto an empty strip.
  useEffect(() => {
    if (!active) newChat();
  }, [active, newChat]);

  const elsewhere = active
    ? active === floatingId
      ? "floating"
      : active === pageId
        ? "page"
        : null
    : null;

  return (
    // The body runs from the page's black down to the panels' step-up
    // (`--sidebar`, one step lifted in either theme), so the
    // composer sits on the lifted end. The tab strip floats over the top and
    // the thread scrolls up under it into a blur, as under the coding chat's
    // header (`transcript.tsx`).
    <div className="relative flex h-full min-h-0 flex-col bg-linear-to-b from-background to-sidebar">
      <TabStrip />
      <GradualBlur
        position="top"
        height="calc(var(--titlebar-height) + 28px)"
        strength={2.1}
        layers={5}
        tint="color-mix(in srgb, var(--background) 90%, transparent)"
        className="z-panel"
      />
      {active && elsewhere ? (
        <div className="flex flex-1 flex-col" style={{ paddingTop: "var(--titlebar-height)" }}>
          <Elsewhere id={active} where={elsewhere} />
        </div>
      ) : active ? (
        <OrgAgentThread
          key={active}
          askId={active}
          size="compact"
          topInset="var(--titlebar-height)"
        />
      ) : null}
    </div>
  );
}

/** The conversations open here, as tabs in the window's own strip
 *  (`pane-tab.tsx`) — icon and title, the selected one filled — with New
 *  right after the last; Minimise and Full screen at the end, plain icons. */
function TabStrip() {
  const tabs = useOrgAgentStore.use.tabs();
  const activeId = useOrgAgentStore.use.activeId();
  const floatingId = useOrgAgentStore.use.floatingId();
  const pageId = useOrgAgentStore.use.pageId();
  const unread = useOrgAgentStore.use.unread();
  const { activate, closeTab, newChat, minimise, fullScreen } = useOrgAgentStore.use.actions();
  const stripRef = useRef<HTMLDivElement>(null);
  const edges = useStripEdges(stripRef);
  const mask = fadeMask(edges);
  // Minimise and Full screen act on a conversation that is HERE.
  const here = activeId && activeId !== floatingId && activeId !== pageId ? activeId : null;

  return (
    <HintGroup>
      {/* The rule on TOP, continuing the surfaces pane's own tab bar line
          above; nothing below — the thread fades under it instead. */}
      <div className="absolute inset-x-0 top-0 z-titlebar flex h-titlebar items-center gap-1 border-t border-border px-2">
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Agent conversations"
          style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
          onWheel={(e) => {
            if (e.deltaY !== 0 && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) {
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}
          className="hide-scrollbar flex min-w-0 shrink items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((id) => {
            const active = id === activeId;
            const away = id === floatingId ? "floating" : id === pageId ? "full page" : null;
            return (
              <TabTitle key={id} id={id}>
                {(title, busy, waiting) => (
                  <div
                    role="tab"
                    tabIndex={0}
                    aria-selected={active}
                    title={away ? `${title} — open in the ${away}` : title}
                    onClick={() => activate(id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate(id);
                      }
                    }}
                    className={cn(
                      // The window's tab (`pane-tab.tsx`): a status mark on the
                      // left that turns into the close button on hover, then the
                      // title.
                      "group/tab flex h-6 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1 text-xs outline-none transition-colors select-none",
                      "focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                      active
                        ? "bg-element-selected text-foreground"
                        : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
                    )}
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center">
                      <span className="flex items-center justify-center group-hover/tab:invisible">
                        {waiting ? (
                          <span className="size-1.5 rounded-full bg-warning" />
                        ) : busy ? (
                          <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                        ) : unread.includes(id) ? (
                          <span className="size-1.5 rounded-full bg-primary" />
                        ) : away === "floating" ? (
                          <PictureInPicture2 size={14} />
                        ) : away ? (
                          <Maximize2 size={13} />
                        ) : (
                          <MessageSquare size={14} />
                        )}
                      </span>
                      <button
                        type="button"
                        aria-label={`Close ${title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(id);
                        }}
                        className="absolute inset-0 hidden items-center justify-center rounded-sm text-muted-foreground group-hover/tab:flex hover:bg-element-selected hover:text-foreground"
                      >
                        <X size={12} />
                      </button>
                    </span>
                    <span className="truncate">{title}</span>
                  </div>
                )}
              </TabTitle>
            );
          })}
        </div>
        <HintItem label="New chat">
          <IconButton
            icon={Plus}
            label="New chat"
            size="sm"
            iconSize="md"
            onClick={() => newChat()}
          />
        </HintItem>
        <span className="flex-1" />
        <HintItem label="Minimise to a floating chat">
          <IconButton
            icon={Minus}
            label="Minimise to a floating chat"
            size="sm"
            iconSize="md"
            disabled={!here}
            onClick={() => here && minimise(here)}
          />
        </HintItem>
        <HintItem label="Full screen">
          <IconButton
            icon={Maximize2}
            label="Full screen"
            size="sm"
            iconSize="md"
            disabled={!here}
            onClick={() => {
              if (!here) return;
              fullScreen(here);
              revealAgentPage();
            }}
          />
        </HintItem>
      </div>
    </HintGroup>
  );
}

/** One tab's title and marks, subscribed per tab so a frame streaming into
 *  one conversation redraws only its own tab. */
function TabTitle({
  id,
  children,
}: {
  id: string;
  children: (title: string, busy: boolean, waiting: boolean) => React.ReactNode;
}) {
  const title = useOrgAgentStore((s) => askTitle(s, id));
  const busy = useOrgAgentStore((s) => askBusy(s, id));
  const waiting = useOrgAgentStore((s) => askWaiting(s, id));
  return <>{children(title, busy, waiting)}</>;
}

/** What the panel shows for a conversation that is open somewhere else —
 *  never the conversation itself, which would then be on screen twice. */
function Elsewhere({ id, where }: { id: string; where: "floating" | "page" }) {
  const { restoreToPanel } = useOrgAgentStore.use.actions();
  const pageShown = useLayoutStore((s) => s.destinationShown && s.destination?.type === "agent");
  const floating = where === "floating";
  const Glyph = floating ? PictureInPicture2 : Maximize2;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <span className="grid size-10 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
        <Glyph size={16} />
      </span>
      <p className="mt-4 text-md text-foreground">
        {floating ? "Open in a floating chat" : "Open in the main view"}
      </p>
      <p className="mt-1 max-w-[260px] text-sm text-muted-foreground">
        {floating
          ? "This conversation is floating over the window. Bring it back to keep it here."
          : "This conversation has the full page. Bring it back to keep it beside your session."}
      </p>
      <div className="mt-4 flex gap-2">
        {!floating && !pageShown && (
          <button type="button" onClick={() => revealAgentPage()} className={PILL_OUTLINE}>
            Show it
          </button>
        )}
        <button
          type="button"
          className={PILL_SOLID}
          onClick={() => {
            restoreToPanel(id);
            // Leaving the page for the session with the panel beside it.
            if (!floating && pageShown) useLayoutStore.getState().actions.hideDestination();
          }}
        >
          Bring it back here
        </button>
      </div>
    </div>
  );
}

/** The placeholder's two pills: the quiet one outlined, the action filled —
 *  the share sheet's Copy link (`share-morph.tsx`). */
const PILL_OUTLINE =
  "flex h-7 cursor-pointer items-center rounded-full border border-border px-3.5 text-xs font-medium text-secondary-foreground transition-colors duration-fast hover:bg-element-hover hover:text-foreground";
const PILL_SOLID =
  "flex h-7 cursor-pointer items-center rounded-full bg-foreground px-3.5 text-xs font-medium text-background transition-opacity duration-fast hover:opacity-85";
