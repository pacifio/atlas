// What can be done to one of a session's linked pull requests, from the
// session's pull request panel, the sidebar badge's list and the session
// context overlay alike: open it (a tab in a checkout of its repository, or
// on the host), copy its link, watch or stop watching it, unlink it. Each
// toasts its outcome; none throws.
//
// The link's URL came from the host through Rust, but it is still checked to
// be a pull request address before the system opener sees it: PR text is
// untrusted, and the opener is only for the pull request's own page.

import { toast } from "sonner";

import type { PullRequestLink } from "@/features/chat/lib/history-api";
import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { copyText } from "@/lib/clipboard";

import { openLinkedPullRequest, parsePullRequestUrl } from "./open-linked-pull-request";
import { classifyPrError, prErrorMessage } from "./pr-errors";
import { unlinkSessionPullRequest, watchSessionPullRequest } from "./session-pull-requests-api";

/** Whether a click asked for the host instead of a tab: ⌘ on macOS, Ctrl
 *  elsewhere, or a middle click. */
export function wantsHost(event: { metaKey: boolean; ctrlKey: boolean; button?: number }): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}

/** Open the link's own pull request page on the host, and nothing else. */
export function openLinkOnHost(link: Pick<PullRequestLink, "url">): void {
  if (parsePullRequestUrl(link.url)) openPullRequest(link.url);
  else toast.error("That link is not a pull request address");
}

/** Open the link: a tab in the first of `checkouts` that is its repository,
 *  else (or when `external`) on the host. */
export function openSessionLink(
  link: PullRequestLink,
  checkouts: readonly string[],
  opts: { external?: boolean; openedFrom?: string } = {},
): void {
  if (opts.external) {
    openLinkOnHost(link);
    return;
  }
  void openLinkedPullRequest(
    checkouts,
    {
      repository: link.repository,
      number: link.number,
      url: link.url,
      title: link.snapshot?.title,
    },
    opts,
  );
}

export async function copySessionLink(link: Pick<PullRequestLink, "url">): Promise<void> {
  if (await copyText(link.url)) toast.success("Link copied", { description: link.url });
  else toast.error("Could not copy the link");
}

/** Whether the eye can be turned on: only an open pull request is watched
 *  (a link the host has not been read for yet counts as open). */
export function canWatch(link: PullRequestLink): boolean {
  return !link.snapshot || link.snapshot.state === "open";
}

export async function setSessionLinkWatching(
  threadId: string,
  link: PullRequestLink,
  watching: boolean,
): Promise<void> {
  try {
    await watchSessionPullRequest(threadId, link.repository, link.number, watching);
    toast.success(
      watching ? `Watching #${link.number}` : `Stopped watching #${link.number}`,
      watching
        ? {
            description:
              "The session's agent wakes when checks finish, someone comments, or the branch conflicts.",
          }
        : undefined,
    );
  } catch (raw) {
    toast.error(watching ? "Could not watch the pull request" : "Could not stop watching", {
      description: prErrorMessage(classifyPrError(raw)),
    });
  }
}

export async function unlinkSessionLink(threadId: string, link: PullRequestLink): Promise<void> {
  try {
    await unlinkSessionPullRequest(threadId, link.repository, link.number);
    toast.success(`Unlinked #${link.number} from this session`);
  } catch (raw) {
    toast.error("Could not unlink the pull request", {
      description: prErrorMessage(classifyPrError(raw)),
    });
  }
}
