// A PR's page on the host, opened in the system browser.
//
// A session's pull requests ride on its history row (`ThreadRow.pullRequests`,
// kept by `session_pull_requests_*`); everything else about a pull request
// goes through `pull-requests/lib/pull-requests-api.ts`.

import { openUrl } from "@tauri-apps/plugin-opener";

/** Whether `url` is a web page: the only thing the webview fallback opens.
 *  Markdown from a pull request body can name any scheme (`javascript:`,
 *  `file:`, a custom handler), and the fallback must not run those. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Open a PR's page in the system browser. */
export function openPullRequest(url: string): void {
  void openUrl(url).catch(() => {
    if (isWebUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
  });
}
