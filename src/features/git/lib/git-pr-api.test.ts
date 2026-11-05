// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { isWebUrl, openPullRequest } from "./git-pr-api";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  openUrl.mockReset();
  vi.restoreAllMocks();
});

describe("openPullRequest", () => {
  it("knows a web page from anything else", () => {
    expect(isWebUrl("https://github.com/acme/shop/pull/1")).toBe(true);
    expect(isWebUrl("http://example.com")).toBe(true);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
  });

  it("falls back to the webview only for http(s)", async () => {
    openUrl.mockRejectedValue(new Error("no opener"));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openPullRequest("javascript:alert(1)");
    await flush();
    expect(open).not.toHaveBeenCalled();

    openPullRequest("https://github.com/acme/shop/pull/1");
    await flush();
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/shop/pull/1",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
