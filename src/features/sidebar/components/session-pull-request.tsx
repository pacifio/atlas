// A session's linked pull requests, as the sidebar shows them: the badge on a
// row, its hover list, and the lines in the row's hover card.
//
// The data is the session row's own `pullRequests` (opened from the session,
// found on its branch, linked by the user or by the agent), kept current by
// the sidebar's sweep. Nothing here reads the host. Every export renders
// nothing for a session with none.
//
// The badge: one pull request reads as its state and number, and a click
// opens it; several read as "+N" (or, all in one chain derived from base
// branches, as a stack of N), and a click opens the session's pull request
// panel. Hovering it lists them all, chains indented under their base.
// ⌘-click (Ctrl elsewhere) opens the pull request on GitHub instead.

import { useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Layers } from "lucide-react";

import type { AttachedProject, PullRequestLink } from "@/features/chat/lib/history-api";
import { STATE_PRESENTATION } from "@/features/pull-requests/components/pull-request-presentation";
import { openSessionPullRequestsTab } from "@/features/pull-requests/lib/open-session-pull-requests-tab";
import { sessionCheckouts } from "@/features/pull-requests/lib/session-checkouts";
import { sessionPullRequestRows } from "@/features/pull-requests/lib/session-pull-request-chains";
import {
  openSessionLink,
  wantsHost,
} from "@/features/pull-requests/lib/session-pull-request-actions";
import {
  LINK_SOURCE_LABEL,
  linkKey,
  linkState,
  pullRequestBadge,
} from "@/features/pull-requests/lib/session-pull-request-links";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** What the sidebar knows of the session the pull requests belong to. */
export interface BadgeSession {
  threadId: string;
  title: string;
  cwd: string;
  attachedProjects: readonly AttachedProject[];
  pullRequests: readonly PullRequestLink[];
}

/** "Open pull request #12: Add discounts" */
function linkLabel(link: PullRequestLink): string {
  const state = STATE_PRESENTATION[linkState(link)];
  const title = link.snapshot?.title;
  return `${state.label} pull request #${link.number}${title ? `: ${title}` : ""}`;
}

/** Open `link`: a tab in a checkout of its repository (the session's, an
 *  attached project's, any project's), or on the host. */
function open(session: BadgeSession, link: PullRequestLink, external: boolean): void {
  const checkouts = sessionCheckouts(
    { folderPaths: [session.cwd], attachedProjects: [...session.attachedProjects] },
    session.cwd,
  );
  openSessionLink(link, checkouts, { external });
}

/** The badge's own button: a glyph and a few characters in the state's
 *  colour, underlined on hover like a link. */
function BadgeButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm text-xs tabular-nums hover:underline",
        className,
      )}
    />
  );
}

/** Clicks inside the badge's popover are portalled out of the row in the
 *  DOM, but not in React: keep them from reaching the row's own handlers. */
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** The row's badge, with its hover list. `onOpenChange` tells the row when
 *  the list shows, so its own hover card stays out of the way. */
export function SessionPullRequestBadge({
  session,
  onOpenChange,
}: {
  session: BadgeSession;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open_, setOpen] = useState(false);
  const badge = pullRequestBadge(session.pullRequests);
  if (!badge) return null;
  const total = badge.others + 1;
  const several = badge.others > 0;
  const aggregate = STATE_PRESENTATION[badge.state];
  const current = STATE_PRESENTATION[linkState(badge.link)];
  const Icon = badge.stacked ? Layers : several ? aggregate.Icon : current.Icon;
  const tone = several ? aggregate.toneClassName : current.toneClassName;
  const text = badge.stacked ? `${total}` : several ? `+${total}` : `#${badge.link.number}`;
  const label = badge.stacked
    ? `Stack of ${total} pull requests, ${aggregate.label.toLowerCase()}`
    : several
      ? `${total} linked pull requests, ${aggregate.label.toLowerCase()}`
      : linkLabel(badge.link);
  const setBoth = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setBoth(false);
    // ⌘-click opens the current one on GitHub, however many there are.
    if (wantsHost(event)) open(session, badge.link, true);
    else if (several) {
      openSessionPullRequestsTab({
        threadId: session.threadId,
        cwd: session.cwd,
        title: session.title,
      });
    } else open(session, badge.link, false);
  };

  return (
    <Popover open={open_} onOpenChange={setBoth}>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={120}
        aria-label={`${label}. ${several ? "Open the session's pull requests" : "Open it"}; ⌘-click opens on GitHub`}
        onPointerDown={stop}
        onClick={onClick}
        render={<BadgeButton className={tone} />}
      >
        <Icon aria-hidden className="size-3 shrink-0" />
        <span>{text}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-80 p-1">
        {open_ ? (
          // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- only stops the row from hearing clicks portalled out of it.
          <div onClick={stop} onPointerDown={stop}>
            <PullRequestMiniList
              pullRequests={session.pullRequests}
              onOpen={(link, external) => {
                setBoth(false);
                open(session, link, external);
              }}
            />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The linked pull requests as compact lines, chains indented under their
 *  base, the base marked "chain · N". */
function PullRequestMiniList({
  pullRequests,
  onOpen,
  trailing,
}: {
  pullRequests: readonly PullRequestLink[];
  onOpen: (link: PullRequestLink, external: boolean) => void;
  trailing?: (link: PullRequestLink) => ReactNode;
}) {
  const lines = sessionPullRequestRows(pullRequests);
  return (
    <ul className="flex flex-col">
      {lines.map(({ link, depth, chain }) => {
        const state = STATE_PRESENTATION[linkState(link)];
        return (
          <li key={linkKey(link)} style={{ paddingLeft: `${Math.min(depth, 3) * 0.75}rem` }}>
            <button
              type="button"
              aria-label={`${linkLabel(link)} — open`}
              title={`${link.url}\n${LINK_SOURCE_LABEL[link.source]} · ⌘-click opens on GitHub`}
              onClick={(event) => onOpen(link, wantsHost(event))}
              className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-element-hover focus-visible:bg-element-hover focus-visible:outline-none"
            >
              <state.Icon aria-hidden className={cn("size-3 shrink-0", state.toneClassName)} />
              <span className="shrink-0 font-mono text-foreground tabular-nums">
                #{link.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-secondary-foreground">
                {link.snapshot?.title ?? link.repository}
              </span>
              {chain ? (
                <span className="shrink-0 text-2xs text-foreground">chain · {chain.size}</span>
              ) : null}
              {trailing?.(link)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The hover card's lines: the same list, inside the row's card. */
export function SessionPullRequestLines({ session }: { session: BadgeSession }) {
  if (session.pullRequests.length === 0) return null;
  return (
    <div className="-mx-1.5 min-w-0">
      <PullRequestMiniList
        pullRequests={session.pullRequests}
        onOpen={(link, external) => open(session, link, external)}
      />
    </div>
  );
}
