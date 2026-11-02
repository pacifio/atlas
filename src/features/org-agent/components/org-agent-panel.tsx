// The Organisation agent, full page — the `agent` destination: the history
// on the left, one conversation given the room on the right. Reached from the
// sidebar's Agent row, or from a conversation's Full screen in the side panel;
// the bar's "Back to the side panel" returns the conversation home
// (`org-agent-side-panel.tsx`), which in the meantime says it is up here.
//
// The history is kept plain: the Organisation (its logo and name) over it
// with New and Collapse, then Pinned and Recents — titles only, pin and delete
// on hover. The conversation's header floats over it, title on the left and
// Share and New on the right, the thread scrolling under it into the coding
// chat's progressive blur (`transcript.tsx`).

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Minimize2, PanelLeft, Pin, PinOff, Plus, Repeat, Share, Trash2 } from "lucide-react";

import { GradualBlur } from "@/components/gradual-blur";
import { OrgAvatar } from "@/features/organisations/components/org-switcher";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { GlassIconButton } from "@/features/sidebar/components/glass-icon-button";
import { CollapsibleSectionHeader } from "@/features/sidebar/components/sidebar-section-header";
import { copyText } from "@/lib/clipboard";
import { SPRING_RAIL } from "@/lib/motion";
import { formatDateTime } from "@/lib/format-time";
import { timeAgo } from "@/lib/time-ago";

import { DestinationActions } from "@/features/layout/components/destination-actions";
import { revealAgentPanel } from "@/features/layout/lib/org-agent";
import { cn } from "@/lib/utils";

import type { AskSummary } from "../lib/org-agent-types";
import {
  askBusy,
  askTitle,
  askWaiting,
  asksByRecent,
  isTempAsk,
  useOrgAgentStore,
} from "../stores/org-agent-store";
import { OrgAgentLoops } from "./org-agent-loops";
import { OrgAgentThread } from "./org-agent-thread";

/** The history rail: 90% of the app sidebar's 244px (`app-layout.tsx`). */
const HISTORY_WIDTH = Math.round(244 * 0.9);

export function OrgAgentPanel() {
  const asks = useOrgAgentStore.use.asks();
  const pageId = useOrgAgentStore.use.pageId();
  const pageView = useOrgAgentStore.use.pageView();
  const pinned = useOrgAgentStore.use.pinned();
  const asksLoaded = useOrgAgentStore.use.asksLoaded();
  const asksCursor = useOrgAgentStore.use.asksCursor();
  const asksError = useOrgAgentStore.use.asksError();
  const connection = useOrgAgentStore.use.connection();
  const { newChat, restoreToPanel, loadAsks, loadMoreAsks, setPageView } =
    useOrgAgentStore.use.actions();
  const [collapsed, setCollapsed] = useState(false);
  const reduceMotion = useReducedMotion();
  const org = useOrgStore((s) => s.organisations.find((o) => o.id === s.activeOrganisationId));
  const selected = pageId;
  const selectedTitle = useOrgAgentStore((s) => (pageId ? askTitle(s, pageId) : ""));
  const loops = pageView === "loops";

  const pinnedList = pinned.map((id) => asks[id]).filter((a): a is AskSummary => !!a);
  const recents = asksByRecent(asks).filter((a) => !pinned.includes(a.id));

  // The history, read when the page opens on a live socket.
  useEffect(() => {
    if (connection === "open" && !asksLoaded) void loadAsks();
  }, [connection, asksLoaded, loadAsks]);

  // Arriving with nothing chosen: a fresh conversation, as the web opens on
  // "New conversation".
  useEffect(() => {
    if (!selected && !loops) newChat({ on: "page" });
  }, [selected, loops, newChat]);

  return (
    // A rule along the top, under the window's bar, as the Timeline has.
    // The history sits on the sidebar's chrome, a step off the black; the
    // conversation runs edge to edge beside it and casts a soft shadow over
    // it, so the two read as a rail and the thing it holds.
    // The top rule matches the divider below it: the rail divider's colour.
    <div className="flex h-full min-h-0 border-t border-[var(--atlas-rail-divider)] bg-sidebar">
      {selected && !loops && (
        <DestinationActions>
          <GlassIconButton
            icon={Minimize2}
            label="Back to the side panel"
            onClick={() => {
              restoreToPanel(selected);
              revealAgentPanel();
            }}
          />
        </DestinationActions>
      )}

      {/* The history: 90% of the app sidebar's width (`app-layout.tsx`'s
          244px), a step narrower so it reads as the second rail. Collapsing animates
          its width on the rail spring; the contents keep their own width
          inside the clipping box, so the titles never re-wrap mid-motion. */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 0 : HISTORY_WIDTH }}
        transition={reduceMotion ? { duration: 0 } : SPRING_RAIL}
        aria-hidden={collapsed}
        inert={collapsed}
        className="shrink-0 overflow-hidden"
      >
        <div className="flex h-full flex-col" style={{ width: HISTORY_WIDTH }}>
          <div className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-4">
            {org && <OrgAvatar org={org} size={20} />}
            <span className="min-w-0 flex-1 truncate text-md font-medium tracking-tight text-foreground">
              {org?.name ?? "Atlas"}
            </span>
            <GlassIconButton icon={Plus} label="New chat" onClick={() => newChat({ on: "page" })} />
            <GlassIconButton
              icon={PanelLeft}
              label="Hide history"
              onClick={() => setCollapsed(true)}
            />
          </div>
          <div className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pt-2 pb-4">
            <button
              type="button"
              onClick={() => setPageView(loops ? "chat" : "loops")}
              aria-current={loops ? "page" : undefined}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-fast",
                loops
                  ? "bg-element-active text-foreground"
                  : "text-secondary-foreground hover:bg-element-hover",
              )}
            >
              <Repeat size={13} className="shrink-0 text-muted-foreground" />
              Loops
            </button>
            {pinnedList.length > 0 && (
              <Section label="Pinned">
                {pinnedList.map((c) => (
                  <Row key={c.id} conversation={c} pinned />
                ))}
              </Section>
            )}
            {/* Headers only once there is something to tell apart: with
                nothing pinned, the list is just the list. */}
            {pinnedList.length > 0 ? (
              <Section label="Recents">
                {recents.map((c) => (
                  <Row key={c.id} conversation={c} pinned={false} />
                ))}
              </Section>
            ) : recents.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted-foreground">
                {!asksLoaded && connection === "open"
                  ? "Loading…"
                  : (asksError ?? "No conversations yet.")}
              </p>
            ) : (
              <ul className="flex flex-col gap-px">
                {recents.map((c) => (
                  <Row key={c.id} conversation={c} pinned={false} />
                ))}
              </ul>
            )}
            {asksCursor && (
              <button
                type="button"
                onClick={() => void loadMoreAsks()}
                className="cursor-pointer self-start px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Show older
              </button>
            )}
          </div>
        </div>
      </motion.aside>

      <section
        className={cn(
          "relative flex min-w-0 flex-1 flex-col bg-background",
          // The divider between the history and the conversation — the app
          // sidebar's own divider colour (`--atlas-rail-divider`), so the two
          // rails' edges match. With the history hidden there is nothing to
          // divide from.
          !collapsed && "border-l border-[var(--atlas-rail-divider)]",
        )}
      >
        {/* The shadow cast over the history: the elevation scale's `md`, at
            70% — a transparent box carrying it, so the strength is an
            opacity rather than a hand-tuned shadow. It shows on the left
            only; the other edges meet the window. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 shadow-md opacity-70" />
        {/* Floats over the thread, which scrolls under it into the blur. */}
        <header className="absolute inset-x-0 top-0 z-titlebar flex h-12 items-center gap-2 px-5">
          <AnimatePresence initial={false}>
            {collapsed && (
              <motion.span
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: reduceMotion ? 0 : 0.16 }}
                className="flex"
              >
                <GlassIconButton
                  icon={PanelLeft}
                  label="Show history"
                  onClick={() => setCollapsed(false)}
                />
              </motion.span>
            )}
          </AnimatePresence>
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {loops
              ? "Loops"
              : selected && !isTempAsk(selected)
                ? selectedTitle
                : "New conversation"}
          </p>
          {!loops && selected && !isTempAsk(selected) && (
            <GlassIconButton
              icon={Share}
              label="Copy link"
              onClick={() => {
                // The same conversation on the web: only its owner can open it.
                void copyText(
                  `https://app.tryatlas.cc/agent?ask=${encodeURIComponent(selected)}`,
                ).then((ok) =>
                  ok ? toast.success("Link copied") : toast.error("Could not copy the link"),
                );
              }}
            />
          )}
          <GlassIconButton icon={Plus} label="New chat" onClick={() => newChat({ on: "page" })} />
        </header>
        <GradualBlur
          position="top"
          height="82px"
          strength={2.1}
          layers={5}
          tint="color-mix(in srgb, var(--background) 90%, transparent)"
          className="z-panel"
        />
        {loops ? (
          <div
            // Clear of the header and its blur band, as the thread is.
            className="hide-scrollbar min-h-0 flex-1 overflow-y-auto pt-16"
          >
            <OrgAgentLoops />
          </div>
        ) : (
          selected && <OrgAgentThread key={selected} askId={selected} size="page" topInset="48px" />
        )}
      </section>
    </div>
  );
}

/** A collapsible history section — the sidebar's own section header
 *  (`sidebar-section-header.tsx`): the label, a hairline, the chevron. */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <CollapsibleSectionHeader expanded={open} size="sm" onClick={() => setOpen(!open)}>
        {label}
      </CollapsibleSectionHeader>
      {open && <ul className="mt-0.5 flex flex-col gap-px">{children}</ul>}
    </section>
  );
}

function Row({ conversation: c, pinned }: { conversation: AskSummary; pinned: boolean }) {
  const pageId = useOrgAgentStore.use.pageId();
  const pageView = useOrgAgentStore.use.pageView();
  const unread = useOrgAgentStore((s) => s.unread.includes(c.id));
  const busy = useOrgAgentStore((s) => askBusy(s, c.id));
  const waiting = useOrgAgentStore((s) => askWaiting(s, c.id));
  const title = useOrgAgentStore((s) => askTitle(s, c.id));
  const { openOnPage, togglePin, deleteConversation } = useOrgAgentStore.use.actions();
  const [confirming, setConfirming] = useState(false);
  const active = c.id === pageId && pageView === "chat";
  const temp = isTempAsk(c.id);

  return (
    <li className="group/item relative" data-slot="org-agent-history-row">
      <button
        type="button"
        onClick={() => openOnPage(c.id)}
        aria-current={active ? "page" : undefined}
        className={cn(
          // Title (up to three lines) over when it was last active; the pin
          // and delete buttons sit over the top-right corner, so the text
          // leaves room for them.
          "flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 pr-14 text-left transition-colors duration-fast",
          active ? "bg-element-active" : "hover:bg-element-hover",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "line-clamp-3 text-sm leading-snug break-words",
              active ? "text-foreground" : "text-secondary-foreground",
            )}
          >
            {title}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {waiting ? (
              <span
                aria-label="Waiting for you"
                className="size-1.5 shrink-0 rounded-full bg-warning"
              />
            ) : busy ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground"
              />
            ) : unread ? (
              <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />
            ) : null}
            <span title={formatDateTime(c.updated_at)}>
              {waiting
                ? "Waiting for you"
                : busy
                  ? "Working…"
                  : timeAgo(new Date(c.updated_at).toISOString(), { suffix: true })}
            </span>
          </span>
        </span>
      </button>
      {!temp && (
        <span
          className={cn(
            "absolute top-1.5 right-1.5 flex items-center transition-opacity group-hover/item:opacity-100 focus-within:opacity-100",
            confirming ? "opacity-100" : "opacity-0",
          )}
        >
          {confirming ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  void deleteConversation(c.id).catch((e) =>
                    toast.error(
                      e instanceof Error ? e.message : "Could not delete the conversation",
                    ),
                  );
                }}
                className="flex h-6 cursor-pointer items-center rounded-md bg-error-muted px-1.5 text-2xs text-error hover:opacity-90"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex h-6 cursor-pointer items-center rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-element-hover"
              >
                Keep
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
                onClick={() => togglePin(c.id)}
                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-element-hover hover:text-foreground"
              >
                {pinned ? <PinOff size={12} /> : <Pin size={12} />}
              </button>
              <button
                type="button"
                aria-label={`Delete ${title}`}
                onClick={() => setConfirming(true)}
                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-element-hover hover:text-foreground"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}
