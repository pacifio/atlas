// @vitest-environment happy-dom
//
// The sheet's one load-bearing input is which server Project the Session
// belongs to. It was wired to the detail's `remote` prop, which means
// something else entirely — "there is no local copy, read payloads from the
// server" — so a Session of your own that had been pushed was BOTH local and
// shared, `remote` was null for it, and the sheet told you it existed only on
// this machine while a teammate was reading it on the web.

import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { SessionDetail } from "../types";
import { EMPTY_DIRECTORY } from "../lib/author-directory";

const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
  if (cmd === "artifacts_cloud_session_share") return null;
  if (cmd === "artifacts_cloud_session_url") return "https://app.tryatlas.cc/timeline?session=s1";
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args as never),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
// The stage animates with `motion`. happy-dom has no real WAAPI, so cancelling
// on unmount rejects after the test has already passed; none of these cases
// are about the animation.
vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
          const { initial, animate, exit, transition, ...rest } = props;
          void initial;
          void animate;
          void exit;
          void transition;
          return createElement(tag, rest, children);
        },
    },
  ),
}));

const { ShareMorph } = await import("./share-morph");

const detail = {
  summary: { id: "s1", title: "a session" },
  entries: [],
  counts: {},
  tools: [],
} as unknown as SessionDetail;

afterEach(cleanup);

describe("ShareMorph", () => {
  it("offers sharing for a Session that is on the server", async () => {
    render(<ShareMorph detail={detail} projectId="ws_1" directory={EMPTY_DIRECTORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Share session" }));
    expect(screen.queryByText(/only on this machine/)).toBeNull();
    expect(await screen.findByText("Who can open it")).toBeTruthy();
  });

  it("says so only when the Session really has no server Project", () => {
    render(<ShareMorph detail={detail} projectId={null} directory={EMPTY_DIRECTORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Share session" }));
    expect(screen.getByText(/only on this machine/)).toBeTruthy();
    // And it does not pretend to offer a choice it cannot act on.
    expect(screen.queryByText("Who can open it")).toBeNull();
  });

  it("reads the Session's link once opened, not on mount", async () => {
    render(<ShareMorph detail={detail} projectId="ws_1" directory={EMPTY_DIRECTORY} />);
    expect(invoke).not.toHaveBeenCalledWith("artifacts_cloud_session_share", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Share session" }));
    await screen.findByText("Who can open it");
    expect(invoke).toHaveBeenCalledWith("artifacts_cloud_session_share", {
      projectId: "ws_1",
      sessionId: "s1",
    });
  });
});
