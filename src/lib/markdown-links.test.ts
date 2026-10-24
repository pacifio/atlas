// @vitest-environment happy-dom
//
// A click on a file chip in rendered markdown opens the file it names; a
// click on a web link goes to the system browser; nothing else is taken.

import { beforeEach, describe, expect, it, vi } from "vitest";

const openPathLink = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/explorer/lib/open-path-link", () => ({ openPathLink }));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
const openPullRequestHref = vi.hoisted(() => vi.fn((_href: string, _opts: unknown) => true));
vi.mock("@/features/pull-requests/lib/open-pull-request-link", () => ({ openPullRequestHref }));

import { parseMarkdown } from "./markdown-render";
import { onMarkdownClick, onMarkdownCopy, onMarkdownKeyDown } from "./markdown-links";

const ROOT = "/Users/dev/acme-app";

function render(src: string, fileRoot = ROOT): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = parseMarkdown(src, fileRoot);
  root.addEventListener("click", (e) => void onMarkdownClick(e));
  root.addEventListener("keydown", onMarkdownKeyDown);
  document.body.replaceChildren(root);
  return root;
}

/** Let the opener's dynamic import settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.clearAllMocks());

describe("clicks in rendered markdown", () => {
  it("opens a reply's path:line chip at its line", async () => {
    const root = render("See `src/lib/api.ts:42`.");
    root.querySelector<HTMLElement>(".atlas-file-chip .atlas-mention-chip__label")!.click();
    await settle();
    await vi.waitFor(() =>
      expect(openPathLink).toHaveBeenCalledWith({
        path: `${ROOT}/src/lib/api.ts`,
        line: 42,
        column: undefined,
        folder: false,
        root: ROOT,
        trusted: false,
      }),
    );
  });

  it("carries a worktree session's root on its chips, untrusted", async () => {
    // A pull request session runs in a worktree under app data, not in the
    // open project; the chip says which root it was resolved under, so the
    // click can open it in Atlas rather than through the system's opener.
    const worktree = "/Users/dev/Library/Application Support/atlas/worktrees/pr-42";
    const root = render("Run `tools/setup.terminal` to set up.", worktree);
    root.querySelector<HTMLElement>(".atlas-file-chip")!.click();
    await vi.waitFor(() =>
      expect(openPathLink).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `${worktree}/tools/setup.terminal`,
          root: worktree,
          trusted: false,
        }),
      ),
    );
  });

  it("opens a sent @folder chip as a folder", async () => {
    const root = render("@folder:src/lib");
    root.querySelector<HTMLElement>(".atlas-file-chip")!.click();
    await vi.waitFor(() =>
      expect(openPathLink).toHaveBeenCalledWith(
        expect.objectContaining({ path: `${ROOT}/src/lib`, folder: true }),
      ),
    );
  });

  it("opens a focused chip on Enter", async () => {
    const root = render("`src/a.ts`");
    const chip = root.querySelector<HTMLElement>(".atlas-file-chip")!;
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(openPathLink).toHaveBeenCalledTimes(1));
  });

  it("sends a web link to the system browser instead of navigating", async () => {
    const root = render("[docs](https://example.com/)");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/"));
    expect(openPathLink).not.toHaveBeenCalled();
  });

  it("hands a pull request's address to the pull request opener", async () => {
    const root = render("[the fix](https://github.com/acme/web/pull/415)");
    root.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() =>
      expect(openPullRequestHref).toHaveBeenCalledWith("https://github.com/acme/web/pull/415", {
        external: false,
      }),
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("asks for the host on a ⌘-click, and falls back to the browser", async () => {
    openPullRequestHref.mockReturnValueOnce(false);
    const root = render("[the fix](https://github.com/acme/web/pull/415)");
    root
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await vi.waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/web/pull/415"),
    );
    expect(openPullRequestHref).toHaveBeenCalledWith(expect.any(String), { external: true });
  });

  it("leaves a click on plain text alone", () => {
    const root = render("just `code` here");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("code")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("copying a shortened link", () => {
  /** Select all of `root` and fire a copy at it; what landed on the clipboard. */
  function copyAll(root: HTMLElement): { text: string; html: string; taken: boolean } {
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new Map<string, string>();
    const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { setData: (k: string, v: string) => data.set(k, v) },
    });
    onMarkdownCopy(event);
    return {
      text: data.get("text/plain") ?? "",
      html: data.get("text/html") ?? "",
      taken: event.defaultPrevented,
    };
  }

  it("carries the full address in place of the short label", () => {
    const pr = "https://github.com/acme/web/pull/415";
    const copied = copyAll(render(`See ${pr} now.`));
    expect(copied.taken).toBe(true);
    expect(copied.text).toContain(pr);
    expect(copied.text).not.toContain("PR #415");
    expect(copied.html).toContain(`>${pr}</a>`);
  });

  it("leaves a selection without one to the browser", () => {
    expect(copyAll(render("See [the docs](https://example.com/docs).")).taken).toBe(false);
  });
});
