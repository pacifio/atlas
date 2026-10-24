// What a click (or Enter) does on rendered markdown, for the two renderers
// that draw it from an HTML string: `CachedMarkdown` and the streaming tail.
// One delegated listener per rendered message, never one per chip or link.
//
//   - a file chip (`markdown-render.ts`) opens the file (`open-path-link.ts`);
//   - an http(s) link opens in the system browser, rather than navigating the
//     WKWebView away from Atlas — except a pull request's, which opens in
//     its tab (`open-pull-request-link.ts`);
//   - a copy keeps a shortened link's full address (`onMarkdownCopy`).

/** A pull request's address: the cheap check before loading its opener. */
const PULL_REQUEST_URL = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#]|$)/i;

/** The chip a click landed on, if it carries a target. */
function fileChipAt(target: EventTarget | null): HTMLElement | null {
  const el = (target as HTMLElement | null)?.closest?.(".atlas-file-chip[data-file-path]");
  return el instanceof HTMLElement ? el : null;
}

function openFileChip(chip: HTMLElement): void {
  const path = chip.dataset.filePath;
  if (!path) return;
  const line = Number(chip.dataset.fileLine) || undefined;
  const column = Number(chip.dataset.fileColumn) || undefined;
  const folder = chip.dataset.mentionKind === "folder";
  const root = chip.dataset.fileRoot || undefined;
  const trusted = chip.dataset.fileTrusted === "true";
  // Loaded on the first click: the opener pulls in the layout and file-index
  // code, which the markdown renderer has no reason to carry.
  void import("@/features/explorer/lib/open-path-link")
    .then((m) => m.openPathLink({ path, line, column, folder, root, trusted }))
    .catch(() => {});
}

/** Handle a click inside rendered markdown. True when it was taken. */
export function onMarkdownClick(e: MouseEvent): boolean {
  const chip = fileChipAt(e.target);
  if (chip) {
    e.preventDefault();
    openFileChip(chip);
    return true;
  }
  const anchor = (e.target as HTMLElement | null)?.closest?.("a");
  if (anchor instanceof HTMLAnchorElement && anchor.href && /^https?:/i.test(anchor.href)) {
    e.preventDefault();
    const href = anchor.href;
    const openExternally = () =>
      void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch(() => {});
    // A pull request opens in its tab (`pullRequestLinksOpenInApp`), unless
    // it is another repository's or the reader ⌘/Ctrl-clicked for the host.
    if (PULL_REQUEST_URL.test(href)) {
      const external = e.metaKey || e.ctrlKey;
      void import("@/features/pull-requests/lib/open-pull-request-link")
        .then((m) => {
          if (!m.openPullRequestHref(href, { external })) openExternally();
        })
        .catch(openExternally);
      return true;
    }
    openExternally();
    return true;
  }
  return false;
}

/**
 * A copy out of rendered markdown that takes in a shortened web link ("PR #42",
 * `markdown-render.ts`) carries the link's full address in its place, as the
 * plain text and in the HTML. A selection without one is left to the browser.
 */
export function onMarkdownCopy(e: ClipboardEvent): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !e.clipboardData) return;
  const container = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) {
    container.appendChild(selection.getRangeAt(i).cloneContents());
  }
  const shortened = container.querySelectorAll<HTMLElement>("a[data-link-copy]");
  if (shortened.length === 0) return;
  for (const anchor of shortened) anchor.textContent = anchor.dataset.linkCopy ?? "";
  // `innerText` keeps the line breaks a reader sees, which `textContent` does
  // not, and it needs the fragment laid out: briefly, off screen.
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.whiteSpace = "pre-wrap";
  document.body.appendChild(container);
  const text = container.innerText;
  container.remove();
  e.preventDefault();
  e.clipboardData.setData("text/plain", text);
  e.clipboardData.setData("text/html", container.innerHTML);
}

/** Enter or Space on a focused file chip opens it, as a click would. */
export function onMarkdownKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  const chip = fileChipAt(e.target);
  if (!chip || chip !== e.target) return;
  e.preventDefault();
  openFileChip(chip);
}
