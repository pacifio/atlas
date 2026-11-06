// Opening a pull request link: a session's linked pull request (the sidebar
// badge and hover card), and a pull request URL clicked in a transcript
// (`markdown-links.ts`). A link names its own repository, and the tab reads
// by number in the session's checkout, so a link from another repository (an
// agent may link any pull request) opened as `cwd + number` would show an
// unrelated pull request. Only a link to the checkout's own repository opens
// a tab; any other, or one whose checkout cannot be read, opens on the host.
// So does every link while `pullRequestLinksOpenInApp` is off, and a link the
// reader asked to open on the host (a modifier-click).
//
// A caller with more than one checkout to offer (the session's own, the
// projects attached to it, every open project) passes them all, and the
// first that is the link's repository takes it.

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

import { openPullRequestTab } from "./open-pull-request-tab";
import { prProvider } from "./pull-requests-api";
import type { PrProvider } from "./pull-requests-types";

export interface OpenableLink {
  /** `owner/name`. */
  repository: string;
  number: number;
  url: string;
  title?: string | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Whether `link` is a pull request of the checkout `provider` describes. */
export function linkBelongsToCheckout(
  link: Pick<OpenableLink, "repository" | "url">,
  provider: Pick<PrProvider, "host" | "repository">,
): boolean {
  if (link.repository.toLowerCase() !== provider.repository.toLowerCase()) return false;
  const host = hostOf(link.url);
  return host === null || host === provider.host.toLowerCase().replace(/^www\./, "");
}

/** `https://host/owner/name/pull/42`, with anything after the number. */
const PULL_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** A pull request URL as a link, or `null` for any other address. */
export function parsePullRequestUrl(href: string): OpenableLink | null {
  const url = href.trim();
  const match = PULL_URL.exec(url);
  if (!match) return null;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { repository: `${match[2]}/${match[3]}`, number, url };
}

/** Whether pull request links open in a tab at all (the setting). */
export function pullRequestLinksOpenInApp(): boolean {
  return useSettingsStore.getState().settings.pullRequestLinksOpenInApp;
}

/** How long a checkout's repository is trusted before it is read again. */
const PROVIDER_TTL_MS = 5 * 60_000;
const providers = new Map<string, { at: number; read: Promise<PrProvider | null> }>();

/** `path`'s repository, read once per few minutes; `null` when it has none
 *  (not a repository, no remote, `gh` held back). */
function providerOf(path: string): Promise<PrProvider | null> {
  const held = providers.get(path);
  if (held && Date.now() - held.at < PROVIDER_TTL_MS) return held.read;
  const read = prProvider(path).catch(() => null);
  providers.set(path, { at: Date.now(), read });
  return read;
}

/** Test seam: forget the checkouts read so far. */
export function resetCheckoutCacheForTests(): void {
  providers.clear();
}

/**
 * The first of `checkouts` whose repository is `link`'s, or `null`. Read in
 * order, one at a time, so the session's own checkout answers before every
 * other project is asked. Each path is read once however often it repeats.
 */
export async function findCheckoutFor(
  link: Pick<OpenableLink, "repository" | "url">,
  checkouts: readonly string[],
): Promise<string | null> {
  return (await findCheckout(link, checkouts))?.path ?? null;
}

/** `findCheckoutFor`, with the checkout's provider (what the host lets
 *  Atlas do there). */
export async function findCheckout(
  link: Pick<OpenableLink, "repository" | "url">,
  checkouts: readonly string[],
): Promise<{ path: string; provider: PrProvider } | null> {
  for (const path of new Set(checkouts)) {
    const provider = await providerOf(path);
    if (provider && linkBelongsToCheckout(link, provider)) return { path, provider };
  }
  return null;
}

/**
 * Open `link`: as a tab in the first checkout that is its repository's (the
 * session's own first, then any other project), when the setting allows,
 * else on the host. `external` (a modifier-click) and no checkout at all
 * always open on the host. `openedFrom` is the tab asking, for the back
 * arrow.
 */
export async function openLinkedPullRequest(
  cwd: string | readonly string[] | null,
  link: OpenableLink,
  opts: { external?: boolean; openedFrom?: string } = {},
): Promise<void> {
  const checkouts = cwd === null ? [] : typeof cwd === "string" ? [cwd] : cwd;
  if (opts.external || checkouts.length === 0 || !pullRequestLinksOpenInApp()) {
    openPullRequest(link.url);
    return;
  }
  const repoPath = await findCheckoutFor(link, checkouts);
  if (repoPath) {
    openPullRequestTab({
      repoPath,
      number: link.number,
      title: link.title ?? `#${link.number}`,
      ...(opts.openedFrom ? { openedFrom: opts.openedFrom } : {}),
    });
  } else {
    openPullRequest(link.url);
  }
}
