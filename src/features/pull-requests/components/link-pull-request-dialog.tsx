// "Link a pull request…": tie a pull request to a session by its URL or
// number, or by picking one of the repository's open pull requests. A number
// is read in the session's checkout; a URL may name any repository, and is
// linked in the first checkout of it Atlas knows (the session's own, the
// projects attached to it, then every other project).
//
// Opened imperatively (`openLinkPullRequestDialog`) from the session row's
// menu and the overlay's Version Control section, so a menu that closes the
// moment its item runs does not take the dialog with it. One host, mounted
// once at the app root.

import { useDeferredValue, useEffect, useId, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { create } from "zustand";

import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

import { resolveLinkInput } from "../lib/link-pull-request-input";
import { findCheckoutFor } from "../lib/open-linked-pull-request";
import { sessionCheckouts } from "../lib/session-checkouts";
import { classifyPrError, prErrorMessage } from "../lib/pr-errors";
import { usePrList, usePrProvider } from "../lib/pull-requests-queries";
import type { PrListEntry } from "../lib/pull-requests-types";
import { linkKey } from "../lib/session-pull-request-links";
import { linkSessionPullRequest } from "../lib/session-pull-requests-api";
import { resolveStatePresentation } from "./pull-request-presentation";

export interface LinkPullRequestRequest {
  threadId: string;
  /** The session's checkout: a number is read in its repository. */
  repoPath: string;
  /** What is linked already (`owner/name#n`, case-folded), marked in the list. */
  linked: readonly string[];
  /** Other checkouts a URL may resolve in, nearest first (the session's
   *  attached projects); every known project is tried after them. */
  checkouts?: readonly string[];
}

const useRequest = create<{ request: LinkPullRequestRequest | null }>(() => ({ request: null }));

export function openLinkPullRequestDialog(request: LinkPullRequestRequest): void {
  useRequest.setState({ request });
}

const close = () => useRequest.setState({ request: null });

export function LinkPullRequestDialogHost() {
  const request = useRequest((state) => state.request);
  if (!request) return null;
  return (
    <LinkPullRequestDialog key={`${request.threadId}:${request.repoPath}`} request={request} />
  );
}

/** How many open pull requests the picker lists. */
const CANDIDATES = 20;

function LinkPullRequestDialog({ request }: { request: LinkPullRequestRequest }) {
  const id = useId();
  const { threadId, repoPath } = request;
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState(() => new Set(request.linked));

  const provider = usePrProvider(repoPath).data ?? null;
  const resolved = resolveLinkInput(reference);
  // A word that is not a number or a URL searches the open pull requests.
  const search = useDeferredValue(
    resolved.kind === "error" && !/^https?:/i.test(reference.trim()) ? reference.trim() : "",
  );
  const list = usePrList(repoPath, { state: "open", search: search || null, limit: CANDIDATES });
  const candidates = list.data?.entries ?? [];

  useEffect(() => setError(null), [reference]);

  /** Link `number` in `repoPath`, or, for a URL, in a checkout of its
   *  repository. */
  const link = async (number: number, url?: { repository: string; url: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      let checkout = repoPath;
      if (url) {
        const found = await findCheckoutFor(url, [
          repoPath,
          ...(request.checkouts ?? []),
          ...sessionCheckouts(null),
        ]);
        if (!found) {
          setError(
            `No project in Atlas is a checkout of ${url.repository}. Open it as a project, then link the pull request.`,
          );
          setBusy(false);
          return;
        }
        checkout = found;
      }
      const change = await linkSessionPullRequest(threadId, checkout, number);
      setLinked(new Set(change.pullRequests.map(linkKey)));
      toast.success(
        change.changed
          ? `Linked pull request #${number} to the session`
          : `Pull request #${number} was already linked`,
      );
      close();
    } catch (raw) {
      const failure = classifyPrError(raw);
      setError(
        failure.kind === "notFound"
          ? `${url ? url.repository : "This repository"} has no pull request #${number}.`
          : prErrorMessage(failure),
      );
      setBusy(false);
    }
  };

  const submit = () => {
    setDirty(true);
    if (resolved.kind === "number") void link(resolved.number);
    else if (resolved.kind === "url") void link(resolved.number, resolved);
    // A search word that matched one pull request links it; a refused URL
    // never falls through to whichever pull request happens to be listed.
    else if (resolved.kind === "error" && search && candidates.length === 1)
      void link(candidates[0]!.number);
  };

  // A search word is not a mistake; only a malformed URL or number is.
  const validation =
    dirty &&
    resolved.kind === "error" &&
    (/^https?:/i.test(reference.trim()) || /^#?\d/.test(reference.trim()))
      ? resolved.message
      : null;
  const ready = resolved.kind === "number" || resolved.kind === "url";
  const message = validation ?? error;
  const repoKey = provider?.repository ?? "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <form
          className="flex min-h-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Link a pull request</DialogTitle>
            <DialogDescription>
              Paste its URL from any repository, type its number, or pick one of{" "}
              {provider ? provider.repository : "the repository"}'s open pull requests. Atlas shows
              it beside the session and keeps its state current.
            </DialogDescription>
          </DialogHeader>
          <label className="sr-only" htmlFor={`${id}-ref`}>
            Pull request URL, number or search
          </label>
          <Input
            id={`${id}-ref`}
            autoFocus
            placeholder="URL, #42, or search open pull requests"
            value={reference}
            onChange={(event) => {
              setDirty(false);
              setReference(event.target.value);
            }}
          />
          {message ? <p className="text-xs text-error">{message}</p> : null}
          <div
            role="listbox"
            aria-label="Open pull requests"
            className="-mx-1 flex max-h-72 min-h-0 flex-col overflow-y-auto"
          >
            {list.isLoading ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading pull requests…</p>
            ) : list.error ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {prErrorMessage(classifyPrError(list.error))}
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {search ? `No open pull request matches “${search}”.` : "No open pull requests."}
              </p>
            ) : (
              candidates.map((pr) => (
                <CandidateRow
                  key={pr.number}
                  pr={pr}
                  linked={
                    !!repoKey && linked.has(linkKey({ repository: repoKey, number: pr.number }))
                  }
                  disabled={busy}
                  onPick={() => void link(pr.number)}
                />
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {busy ? "Linking…" : ready ? `Link #${resolved.number}` : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  pr,
  linked,
  disabled,
  onPick,
}: {
  pr: PrListEntry;
  linked: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const state = resolveStatePresentation(pr);
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      disabled={disabled || linked}
      onClick={onPick}
      title={pr.url}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
        "cursor-pointer hover:bg-element-hover disabled:cursor-default disabled:hover:bg-transparent",
      )}
    >
      <state.Icon aria-hidden className={cn("size-3.5 shrink-0", state.toneClassName)} />
      <span className="shrink-0 text-muted-foreground tabular-nums">#{pr.number}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{pr.title}</span>
      {linked ? (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <Check aria-hidden className="size-3" />
          Linked
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground">
          {pr.author?.login ?? "ghost"} · {timeAgo(pr.updatedAt)}
        </span>
      )}
    </button>
  );
}
