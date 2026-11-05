// A pull request URL clicked in a transcript (`markdown-links.ts`, which
// loads this on the first such click). The rendered message does not say
// which session it belongs to, so the checkout is the focused session's —
// the one the reader is clicking in — or the current project's. From there
// `openLinkedPullRequest` decides tab or host, as for the sidebar's links.

import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "@/features/chat/stores/chat-store";

import { openLinkedPullRequest, parsePullRequestUrl } from "./open-linked-pull-request";

function readerCheckout(): string | null {
  const chat = useChatStore.getState();
  const tabId = chat.activeSessionId;
  const session = tabId ? chat.sessions[tabId] : undefined;
  const cwd = session?.bindCwd ?? session?.workingDirectory;
  if (cwd) return cwd;
  return useAppStore.getState().currentProject?.path ?? null;
}

/** Open `href` if it is a pull request URL. False when it is not one, for
 *  the caller to open as any other link. */
export function openPullRequestHref(href: string, opts: { external?: boolean } = {}): boolean {
  const link = parsePullRequestUrl(href);
  if (!link) return false;
  void openLinkedPullRequest(readerCheckout(), link, opts);
  return true;
}
