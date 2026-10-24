// One session's linked pull requests, as a surface tab beside it
// (`session-pull-requests:<threadId>`): a row per pull request (state, number
// and title, whether it is watched, its checks and review, its line counts,
// its branches), chains derived from base branches drawn indented under their
// base, and a footer that counts them and says when the host was last read.
//
// A row opens its pull request in a tab in a checkout of its own repository
// (the session's, an attached project's, any project's), with this tab as
// the back arrow's target; ⌘-click opens it on the host. The ⋯ and a
// right-click carry Open, Open on GitHub, Copy link, Watch and Unlink; Shift
// shows the quick actions (Close, Merge, Ready, Reopen). + Link takes a URL
// from any repository or a number in the session's.
//
// The links are the session's history row (`ThreadRow.pullRequests`), which
// re-reads on `atlas:threads-changed`; every link, unlink and watch fires it,
// so the panel follows without being told. Rows are memoized and Shift
// travels by context, so neither a key press nor one link's change redraws
// the rest.

import { memo, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Eye, Layers, Link2, MoreHorizontal, Plus, type LucideIcon } from "lucide-react";

import type { PullRequestLink, ThreadRow } from "@/features/chat/lib/history-api";
import { useThreadHistory } from "@/features/session-context/lib/session-lineage";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";

import {
  toChangeBreakdown,
  type PullRequestChangeBreakdown,
} from "../lib/pull-request-change-breakdown";
import { findCheckout } from "../lib/open-linked-pull-request";
import { prListStats } from "../lib/pull-requests-api";
import type { PrAction, PrProvider } from "../lib/pull-requests-types";
import { sessionCheckouts } from "../lib/session-checkouts";
import {
  latestSyncedAt,
  sessionPullRequestRows,
  type SessionPullRequestLine,
} from "../lib/session-pull-request-chains";
import { LINK_SOURCE_LABEL, linkKey, linkState } from "../lib/session-pull-request-links";
import { openSessionLink, wantsHost } from "../lib/session-pull-request-actions";
import { syncSessionPullRequests } from "../lib/session-pull-requests-api";
import { ChangeBreakdownStat } from "./pull-request-change-breakdown-stat";
import { openLinkPullRequestDialog } from "./link-pull-request-dialog";
import {
  CHECKS_STATE_PRESENTATION,
  REVIEW_DECISION_PRESENTATION,
  STATE_PRESENTATION,
} from "./pull-request-presentation";
import {
  PullRequestQuickActions,
  PullRequestQuickActionsProvider,
  QuickActionModeContext,
  useQuickActionRunnerAnywhere,
  type QuickActionEntry,
} from "./pull-request-quick-actions";
import { SessionPullRequestMenuItems } from "./session-pull-request-menu";

const NO_LINKS: PullRequestLink[] = [];
const NO_ACTIONS: ReadonlySet<PrAction> = new Set();

const CHECKS_LABEL = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
} as const;

/** Where a link's pull request lives here: the checkout of its repository
 *  and what the host lets Atlas do there; `null` when no checkout is. */
type Checkout = { path: string; provider: PrProvider } | null;

/** A row's quick-action entry, carrying the checkout it acts in. */
interface PanelEntry extends QuickActionEntry {
  checkout: string;
}

interface LineCounts {
  additions: number;
  deletions: number;
  breakdown: PullRequestChangeBreakdown | null;
}

// ── reading ─────────────────────────────────────────────────────────────

/** Each link's checkout, found once per link and kept a few minutes. */
function useLinkCheckouts(
  links: readonly PullRequestLink[],
  row: ThreadRow | undefined,
  cwd: string | null,
): ReadonlyMap<string, Checkout | undefined> {
  const latest = useRef({ row, cwd });
  latest.current = { row, cwd };
  const results = useQueries({
    queries: links.map((link) => ({
      queryKey: ["pull-requests", "session-checkout", linkKey(link), link.url, cwd],
      queryFn: () => findCheckout(link, sessionCheckouts(latest.current.row, latest.current.cwd)),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const key = results.map((r) => (r.data === undefined ? "?" : (r.data?.path ?? "-"))).join("|");
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is what changes.
  return useMemo(() => {
    const map = new Map<string, Checkout | undefined>();
    links.forEach((link, index) => map.set(linkKey(link), results[index]?.data));
    return map;
  }, [links, key]);
}

/** Line counts for the links, one batched read per checkout. */
function useLinkLineCounts(
  links: readonly PullRequestLink[],
  checkouts: ReadonlyMap<string, Checkout | undefined>,
): ReadonlyMap<string, LineCounts> {
  const groups = useMemo(() => {
    const byPath = new Map<string, number[]>();
    for (const link of links) {
      const path = checkouts.get(linkKey(link))?.path;
      if (!path) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), link.number]);
    }
    return [...byPath].map(([path, numbers]) => ({ path, numbers: numbers.sort((a, b) => a - b) }));
  }, [links, checkouts]);
  const results = useQueries({
    queries: groups.map((group) => ({
      queryKey: ["pull-requests", group.path, "session-stats", group.numbers.join(",")],
      queryFn: () => prListStats(group.path, group.numbers),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const key = results.map((r) => r.dataUpdatedAt).join("|");
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is what changes.
  return useMemo(() => {
    const map = new Map<string, LineCounts>();
    groups.forEach((group, index) => {
      for (const stat of results[index]?.data ?? []) {
        map.set(`${group.path}#${stat.number}`, {
          additions: stat.additions,
          deletions: stat.deletions,
          breakdown: toChangeBreakdown(stat),
        });
      }
    });
    return map;
  }, [groups, key]);
}

// ── the row ─────────────────────────────────────────────────────────────

function Signal({
  label,
  Icon,
  className,
}: {
  label: string;
  Icon: LucideIcon;
  className?: string;
}) {
  return (
    <span title={label} aria-label={label} role="img" className="inline-flex shrink-0">
      <Icon aria-hidden className={cn("size-3", className)} />
    </span>
  );
}

/** The ⋯, shown on hover; it steps aside while Shift shows the quick
 *  actions in its place. Reads Shift itself, so a key press redraws this
 *  and not the row. */
function MenuSlot({
  entry,
  pinned,
  children,
}: {
  entry: PanelEntry | null;
  /** Its menu is open: stay shown. */
  pinned: boolean;
  children: React.ReactNode;
}) {
  const shift = use(QuickActionModeContext);
  if (shift && entry && entry.state !== "merged" && !pinned) return null;
  return (
    <span
      className={cn(
        "flex opacity-0 transition-opacity group-hover/pr-row:opacity-100 has-[:focus-visible]:opacity-100",
        "group-has-[[data-quick-action-pending=true]]/pr-row:hidden",
        pinned && "opacity-100",
      )}
    >
      {children}
    </span>
  );
}

function SessionPullRequestRowImpl({
  line,
  threadId,
  entry,
  counts,
  onOpen,
}: {
  line: SessionPullRequestLine;
  threadId: string;
  /** Set when the row has a checkout to act in: Shift's quick actions. */
  entry: PanelEntry | null;
  counts: LineCounts | undefined;
  onOpen: (link: PullRequestLink, external: boolean) => void;
}) {
  const { link, depth, chain } = line;
  const snapshot = link.snapshot;
  const state = STATE_PRESENTATION[linkState(link)];
  const open = !snapshot || snapshot.state === "open";
  const checks = open && snapshot?.checksState ? snapshot.checksState : null;
  const review =
    open && snapshot?.reviewDecision ? REVIEW_DECISION_PRESENTATION[snapshot.reviewDecision] : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const title = snapshot?.title ?? `${link.repository}#${link.number}`;
  return (
    <div
      data-session-pull-request={linkKey(link)}
      className={cn(
        "group/pr-row relative flex min-w-0 items-start gap-2 rounded py-1.5 pr-2",
        "hover:bg-element-hover has-[>button:focus-visible]:bg-element-hover",
        menuOpen && "bg-element-hover",
      )}
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      <button
        type="button"
        onClick={(event) => onOpen(link, wantsHost(event))}
        onAuxClick={(event) => {
          if (event.button === 1) onOpen(link, true);
        }}
        aria-label={`${state.label} pull request #${link.number}: ${title}`}
        title={`${link.url}\n${LINK_SOURCE_LABEL[link.source]} · ⌘-click opens on GitHub`}
        className="absolute inset-0 cursor-pointer rounded focus-visible:outline-none"
      />
      {depth > 0 ? (
        <span aria-hidden className="pointer-events-none -ml-2 h-8 w-px shrink-0 bg-border" />
      ) : null}
      <span className="pointer-events-none relative mt-0.5 inline-flex shrink-0">
        <state.Icon aria-hidden className={cn("size-3.5", state.toneClassName)} />
      </span>
      <span className="pointer-events-none relative min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            #{link.number}
          </span>
          <span className="min-w-0 truncate text-xs text-foreground">{title}</span>
          {link.watching ? (
            <Signal
              label="Watching: the agent wakes when checks finish, someone comments, or the branch conflicts"
              Icon={Eye}
              className="text-foreground"
            />
          ) : null}
          {checks ? (
            <Signal
              label={CHECKS_LABEL[checks]}
              Icon={CHECKS_STATE_PRESENTATION[checks].Icon}
              className={CHECKS_STATE_PRESENTATION[checks].toneClassName}
            />
          ) : null}
          {review ? (
            <Signal label={review.label} Icon={review.Icon} className={review.toneClassName} />
          ) : null}
          <span className="ml-auto flex shrink-0 items-center text-2xs">
            {counts ? (
              <ChangeBreakdownStat
                additions={counts.additions}
                deletions={counts.deletions}
                breakdown={counts.breakdown}
              />
            ) : null}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
          {chain ? (
            <span
              title={`${chain.size} pull requests chained by base branch`}
              className="inline-flex shrink-0 items-center gap-0.5 text-secondary-foreground"
            >
              <Layers aria-hidden className="size-2.5" />
              <span className="tabular-nums">{chain.size}</span>
            </span>
          ) : null}
          <span title={link.repository} className="max-w-32 shrink-0 truncate font-mono">
            {link.repository}
          </span>
          {snapshot ? (
            <span
              title={`${snapshot.headBranch} → ${snapshot.baseBranch}`}
              className="min-w-0 truncate font-mono"
            >
              {snapshot.headBranch} → {snapshot.baseBranch}
            </span>
          ) : (
            <span className="min-w-0 truncate">Not read from GitHub yet</span>
          )}
          <span className="ml-auto shrink-0 tabular-nums transition-opacity group-hover/pr-row:opacity-0">
            {timeAgo(snapshot?.updatedAt ?? link.linkedAt)}
          </span>
        </span>
      </span>
      {entry ? (
        <span className="relative self-center">
          <PullRequestQuickActions entry={entry} />
        </span>
      ) : null}
      <span className="absolute right-1 bottom-1 flex items-center">
        <MenuSlot entry={entry} pinned={menuOpen}>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <IconButton icon={MoreHorizontal} label={`Actions for #${link.number}`} size="xs" />
              }
            />
            <DropdownMenuContent align="end">
              {menuOpen ? (
                <SessionPullRequestMenuItems
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                  threadId={threadId}
                  link={link}
                  onOpen={() => onOpen(link, false)}
                />
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </MenuSlot>
      </span>
    </div>
  );
}

const SessionPullRequestRow = memo(SessionPullRequestRowImpl);

// ── the footer ──────────────────────────────────────────────────────────

/** "synced 2m ago", re-read once a minute. Its own component, so the tick
 *  redraws the footer and nothing else. */
function SyncedAgo({ at }: { at: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span title={new Date(at).toLocaleString()}>synced {timeAgo(at, { suffix: true })}</span>;
}

// ── the panel ───────────────────────────────────────────────────────────

export function SessionPullRequestsPanel({
  tabId,
  threadId,
  cwd,
}: {
  tabId: string;
  threadId: string;
  /** The session's checkout, from when the tab was opened. */
  cwd: string | null;
}) {
  const rows = useThreadHistory(true);
  const row = rows.find((r) => r.threadId === threadId);
  const links = row?.pullRequests ?? NO_LINKS;
  const home = cwd ?? row?.folderPaths[0] ?? null;
  const lines = useMemo(() => sessionPullRequestRows(links), [links]);
  const checkouts = useLinkCheckouts(links, row, home);
  const counts = useLinkLineCounts(links, checkouts);

  // Fresh state for the links that are due, once on open.
  useEffect(() => {
    syncSessionPullRequests([threadId]).catch(() => {
      // Held back (gh missing, signed out, rate limited): the snapshots stand.
    });
  }, [threadId]);

  // ── acting ───────────────────────────────────────────────────────────
  const latest = useRef({ row, home, checkouts });
  latest.current = { row, home, checkouts };
  const open = useCallback(
    (link: PullRequestLink, external: boolean) => {
      const { row: r, home: h, checkouts: c } = latest.current;
      const found = c.get(linkKey(link))?.path;
      openSessionLink(link, found ? [found] : sessionCheckouts(r, h), {
        external,
        openedFrom: tabId,
      });
    },
    [tabId],
  );

  const entries = useMemo(() => {
    const map = new Map<string, PanelEntry>();
    for (const link of links) {
      const checkout = checkouts.get(linkKey(link));
      if (!checkout) continue;
      map.set(linkKey(link), {
        number: link.number,
        title: link.snapshot?.title ?? `#${link.number}`,
        state: link.snapshot?.state ?? "open",
        isDraft: link.snapshot?.isDraft ?? false,
        checkout: checkout.path,
      });
    }
    return map;
  }, [links, checkouts]);

  const hostActions = useMemo(() => {
    const actions = new Set<PrAction>();
    for (const checkout of checkouts.values()) {
      for (const action of checkout?.provider.capabilities.actions ?? []) actions.add(action);
    }
    return actions.size > 0 ? actions : NO_ACTIONS;
  }, [checkouts]);
  const runAnywhere = useQuickActionRunnerAnywhere(() => {
    void syncSessionPullRequests([threadId], true).catch(() => {});
  });
  const perform = useCallback(
    (entry: QuickActionEntry, action: Parameters<typeof runAnywhere>[2]) =>
      runAnywhere((entry as PanelEntry).checkout, entry, action),
    [runAnywhere],
  );

  const openLinkDialog = () => {
    if (!home) return;
    openLinkPullRequestDialog({
      threadId,
      repoPath: home,
      linked: links.map(linkKey),
      checkouts: row?.attachedProjects.map((project) => project.path) ?? [],
    });
  };

  // ── the right-click menu ─────────────────────────────────────────────
  const [menuLink, setMenuLink] = useState<PullRequestLink | null>(null);
  const onContextMenu = (event: React.MouseEvent) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-session-pull-request]");
    const key = node?.dataset.sessionPullRequest;
    setMenuLink(key ? (links.find((link) => linkKey(link) === key) ?? null) : null);
  };

  if (!row) {
    return (
      <EmptyState
        title="Session not found"
        detail="This session has no history yet, or it was removed. Its pull requests show here once it has."
      />
    );
  }

  if (links.length === 0) {
    return (
      <EmptyState
        title="No linked pull requests"
        detail="Pull requests the agent opens from this session land here. Link one yourself from a URL or a number."
        action={
          <Button size="sm" variant="outline" disabled={!home} onClick={openLinkDialog}>
            <Plus aria-hidden className="size-3.5" />
            Link pull request
          </Button>
        }
      />
    );
  }

  const openCount = links.filter((link) => !link.snapshot || link.snapshot.state === "open").length;
  const synced = latestSyncedAt(links);
  return (
    <PullRequestQuickActionsProvider hostActions={hostActions} perform={perform}>
      <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                onContextMenu={onContextMenu}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
              />
            }
          >
            <div role="list" aria-label="Linked pull requests" className="p-1.5">
              {lines.map((line) => {
                const key = linkKey(line.link);
                const entry = entries.get(key) ?? null;
                return (
                  <div role="listitem" key={key}>
                    <SessionPullRequestRow
                      line={line}
                      threadId={threadId}
                      entry={entry}
                      counts={
                        entry ? counts.get(`${entry.checkout}#${line.link.number}`) : undefined
                      }
                      onOpen={open}
                    />
                  </div>
                );
              })}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {menuLink ? (
              <SessionPullRequestMenuItems
                Item={ContextMenuItem}
                Separator={ContextMenuSeparator}
                threadId={threadId}
                link={menuLink}
                onOpen={() => open(menuLink, false)}
              />
            ) : (
              <ContextMenuItem onClick={openLinkDialog}>
                <Plus aria-hidden />
                Link a pull request…
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1 text-2xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {openCount} open · {links.length} linked
            {synced ? (
              <>
                {" · "}
                <SyncedAgo at={synced} />
              </>
            ) : null}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={!home}
            onClick={openLinkDialog}
            title="Link a pull request by URL (any repository) or number"
          >
            <Plus aria-hidden className="size-3" />
            Link
          </Button>
        </footer>
      </div>
    </PullRequestQuickActionsProvider>
  );
}

function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center">
      <Link2 aria-hidden className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-60 text-xs text-muted-foreground">{detail}</p>
      {action}
    </div>
  );
}
