import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, openTab, openExternal, settings } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openTab: vi.fn(),
  openExternal: vi.fn(),
  settings: { pullRequestLinksOpenInApp: true },
}));
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings }) },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./open-pull-request-tab", () => ({ openPullRequestTab: openTab }));
vi.mock("@/features/git/lib/git-pr-api", () => ({ openPullRequest: openExternal }));

import { resetGhGateForTests } from "./pr-errors";
import {
  findCheckoutFor,
  linkBelongsToCheckout,
  openLinkedPullRequest,
  parsePullRequestUrl,
  resetCheckoutCacheForTests,
} from "./open-linked-pull-request";

const provider = { host: "github.com", repository: "acme/shop" };
const link = (repository: string, host = "github.com") => ({
  repository,
  number: 12,
  url: `https://${host}/${repository}/pull/12`,
});

afterEach(() => {
  invoke.mockReset();
  openTab.mockReset();
  openExternal.mockReset();
  settings.pullRequestLinksOpenInApp = true;
  resetGhGateForTests();
  resetCheckoutCacheForTests();
});

describe("findCheckoutFor", () => {
  const byPath: Record<string, unknown> = {
    "/shop": { host: "github.com", repository: "acme/shop" },
    "/docs": { host: "github.com", repository: "acme/docs" },
  };

  it("takes the first checkout of the link's repository, reading each once", async () => {
    invoke.mockImplementation((_cmd: string, args: { path: string }) =>
      byPath[args.path] ? Promise.resolve(byPath[args.path]) : Promise.reject({ kind: "failed" }),
    );
    expect(await findCheckoutFor(link("acme/docs"), ["/shop", "/none", "/docs", "/shop"])).toBe(
      "/docs",
    );
    expect(invoke).toHaveBeenCalledTimes(3);
    // Read again within the window: answered from what was read.
    expect(await findCheckoutFor(link("acme/shop"), ["/shop"])).toBe("/shop");
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("is null when no checkout is the link's repository", async () => {
    invoke.mockImplementation((_cmd: string, args: { path: string }) =>
      Promise.resolve(byPath[args.path]),
    );
    expect(await findCheckoutFor(link("other/repo"), ["/shop", "/docs"])).toBeNull();
  });

  it("opens in another project's checkout, with the tab it came from", async () => {
    invoke.mockImplementation((_cmd: string, args: { path: string }) =>
      Promise.resolve(byPath[args.path]),
    );
    await openLinkedPullRequest(["/shop", "/docs"], link("acme/docs"), {
      openedFrom: "session-pull-requests:t1",
    });
    expect(openTab).toHaveBeenCalledWith({
      repoPath: "/docs",
      number: 12,
      title: "#12",
      openedFrom: "session-pull-requests:t1",
    });
  });
});

describe("openLinkedPullRequest", () => {
  it("knows a link of the checkout's own repository and host", () => {
    expect(linkBelongsToCheckout(link("Acme/Shop"), provider)).toBe(true);
    expect(linkBelongsToCheckout(link("other/repo"), provider)).toBe(false);
    expect(linkBelongsToCheckout(link("acme/shop", "ghe.example.com"), provider)).toBe(false);
  });

  it("opens a tab for the checkout's own pull request", async () => {
    invoke.mockResolvedValue(provider);
    await openLinkedPullRequest("/repo", link("acme/shop"));
    expect(openTab).toHaveBeenCalledWith({ repoPath: "/repo", number: 12, title: "#12" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens another repository's pull request on the host, not as cwd + number", async () => {
    invoke.mockResolvedValue(provider);
    await openLinkedPullRequest("/repo", link("other/repo"));
    expect(openTab).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/other/repo/pull/12");
  });

  it("opens on the host when the checkout cannot be read", async () => {
    invoke.mockRejectedValue({ kind: "failed", message: "no remote" });
    await openLinkedPullRequest("/repo", link("acme/shop"));
    expect(openTab).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalled();
  });

  it("opens every link on the host while pullRequestLinksOpenInApp is off", async () => {
    invoke.mockResolvedValue(provider);
    settings.pullRequestLinksOpenInApp = false;
    await openLinkedPullRequest("/repo", link("acme/shop"));
    expect(openTab).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/shop/pull/12");
  });

  it("opens on the host when asked to (a modifier-click), or with no checkout", async () => {
    invoke.mockResolvedValue(provider);
    await openLinkedPullRequest("/repo", link("acme/shop"), { external: true });
    await openLinkedPullRequest(null, link("acme/shop"));
    expect(openTab).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});

describe("parsePullRequestUrl", () => {
  it("reads a pull request's address, with anything after its number", () => {
    expect(parsePullRequestUrl("https://github.com/acme/shop/pull/12/files#diff")).toEqual({
      repository: "acme/shop",
      number: 12,
      url: "https://github.com/acme/shop/pull/12/files#diff",
    });
  });

  it("takes nothing else", () => {
    expect(parsePullRequestUrl("https://github.com/acme/shop/issues/12")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/acme/shop/pull/0")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/acme/shop")).toBeNull();
  });
});
