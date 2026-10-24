// What the tab shows before the pull request arrives, and when it cannot:
// a ghost of the layout to come, and an unavailable state that names the fix
// (install `gh`, sign in, wait out the rate limit) with a retry.

import { useEffect, useState } from "react";
import { ExternalLink, GitPullRequestArrow, RefreshCw } from "lucide-react";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

import { prErrorMessage } from "../lib/pr-errors";
import type { PrError } from "../lib/pull-requests-types";

function GhostBar({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block h-3 rounded bg-muted", className)} />;
}

const COMMENT_WIDTHS = ["w-4/5", "w-3/5", "w-2/3"];

/** The conversation's placeholder while its read is in flight. */
export function ConversationGhost({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading comments" className="animate-pulse space-y-3">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <GhostBar className="size-4 rounded-full" />
            <GhostBar className="w-24" />
            <GhostBar className="w-10" />
          </div>
          <GhostBar className={COMMENT_WIDTHS[index % COMMENT_WIDTHS.length]} />
          <GhostBar className="w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** Picker rows while the candidates load. */
export function PeopleGhost({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse space-y-2 p-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className={index % 2 === 0 ? "w-28" : "w-20"} />
        </div>
      ))}
    </div>
  );
}

/** The whole tab's placeholder: the header's rows, the tab bar, the Summary. */
export function PullRequestDetailGhost({ number }: { number: number }) {
  return (
    <div
      role="status"
      aria-label={`Loading pull request #${number}`}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="animate-pulse border-b border-border px-4 pb-3">
        <div className="flex h-7 items-center gap-2">
          <GhostBar className="w-28" />
          <span className="text-xs font-medium text-muted-foreground">#{number}</span>
          <span className="ml-auto flex gap-1">
            <GhostBar className="h-5 w-24" />
            <GhostBar className="h-5 w-6" />
          </span>
        </div>
        <GhostBar className="mt-1 h-4 w-3/5" />
        <div className="mt-3 flex items-center gap-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className="w-32" />
          <GhostBar className="ml-auto w-28" />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <GhostBar className="w-20" />
          <GhostBar className="w-32" />
          <GhostBar className="ml-auto w-16" />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <GhostBar className="h-6 w-48 rounded-full" />
          <GhostBar className="ml-auto w-28" />
        </div>
      </div>
      <div className="animate-pulse space-y-3 px-4 py-3">
        <GhostBar className="w-1/3" />
        <GhostBar className="w-1/4" />
        <GhostBar className="mt-4 w-full" />
        <GhostBar className="w-11/12" />
        <GhostBar className="w-4/5" />
      </div>
    </div>
  );
}

const TITLES: Partial<Record<PrError["kind"], string>> = {
  notInstalled: "The GitHub CLI is not installed",
  notAuthenticated: "Not signed in to GitHub",
  rateLimited: "GitHub's rate limit was reached",
  network: "GitHub could not be reached",
  notFound: "Pull request not found",
};

/** Ticks once a second until `until`, so a rate-limit reset reads as a countdown. */
function useSecondsUntil(until: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [until]);
  if (!until) return null;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function PullRequestUnavailableState({
  error,
  number,
  url,
  retrying,
  onRetry,
}: {
  error: PrError;
  number: number;
  /** The pull request on GitHub, when it is known. */
  url: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const wait = useSecondsUntil(error.kind === "rateLimited" ? error.retryAt : null);
  const title =
    error.kind === "notFound"
      ? `Pull request #${number} not found`
      : (TITLES[error.kind] ?? "Could not load this pull request");
  const description =
    error.kind === "notFound"
      ? "It may be an issue rather than a pull request, or this account cannot see it."
      : prErrorMessage(error);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-10 text-center">
      <GitPullRequestArrow aria-hidden className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
        {error.kind === "notAuthenticated" ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Run <code className="rounded bg-card px-1 py-px font-mono">gh auth login</code> in a
            terminal, then retry.
          </p>
        ) : null}
        {wait !== null && wait > 0 ? (
          <p className="pt-1 text-xs text-muted-foreground tabular-nums">
            Resets in {Math.floor(wait / 60)}:{String(wait % 60).padStart(2, "0")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
          <RefreshCw aria-hidden className={cn("size-3.5", retrying && "animate-spin")} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
        {url ? (
          <Button size="sm" variant="outline" onClick={() => openPullRequest(url)}>
            <ExternalLink aria-hidden className="size-3.5" />
            Open on GitHub
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The conversation's own failure, inside the Summary. */
export function ActivityUnavailableState({
  error,
  onRetry,
  title = "Could not load the conversation",
}: {
  error: PrError;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-3 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{prErrorMessage(error)}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw aria-hidden className="size-3.5" />
        Retry
      </Button>
    </div>
  );
}

/** The list's placeholder while its first page is in flight. */
export function PullRequestListGhost({ rows = 6, caption }: { rows?: number; caption?: string }) {
  return (
    <div role="status" aria-label={caption ?? "Loading pull requests"} className="space-y-1 p-2">
      {caption ? <p className="px-1 pb-1 text-xs text-muted-foreground">{caption}</p> : null}
      <div className="animate-pulse space-y-1">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-start gap-2 rounded px-2 py-2">
            <GhostBar className="mt-0.5 size-3.5 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <GhostBar className={COMMENT_WIDTHS[index % COMMENT_WIDTHS.length]} />
              <GhostBar className="w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A repository's list could not be read: what to fix, and a retry. */
export function PullRequestsUnavailableState({
  error,
  retrying,
  onRetry,
}: {
  error: PrError;
  retrying: boolean;
  onRetry: () => void;
}) {
  const wait = useSecondsUntil(error.kind === "rateLimited" ? error.retryAt : null);
  const noRepository = error.kind === "notFound" || error.kind === "unsupported";
  const title = noRepository
    ? "No GitHub repository here"
    : (TITLES[error.kind] ?? "Could not load the pull requests");
  const description = noRepository
    ? "This project's remote is not a GitHub repository this account can see."
    : prErrorMessage(error);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-10 text-center">
      <GitPullRequestArrow aria-hidden className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
        {error.kind === "notAuthenticated" ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Run <code className="rounded bg-card px-1 py-px font-mono">gh auth login</code> in a
            terminal, then retry.
          </p>
        ) : null}
        {error.kind === "notInstalled" ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Install it from{" "}
            <code className="rounded bg-card px-1 py-px font-mono">cli.github.com</code>, sign in,
            then retry.
          </p>
        ) : null}
        {wait !== null && wait > 0 ? (
          <p className="pt-1 text-xs text-muted-foreground tabular-nums">
            Resets in {Math.floor(wait / 60)}:{String(wait % 60).padStart(2, "0")}
          </p>
        ) : null}
      </div>
      <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
        <RefreshCw aria-hidden className={cn("size-3.5", retrying && "animate-spin")} />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
