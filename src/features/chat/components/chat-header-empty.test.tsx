// @vitest-environment happy-dom
//
// The header's `empty` form — what the welcome screen shows before a thread
// exists. The bar is there so remote control can be started from a fresh
// chat; everything that needs a message to act on (the session picker, the
// history and "new session" buttons, the role filter, pins, Bash calls, Plans,
// "Branch from here") goes away, and the two round buttons at the right end
// keep their place. The "Remote control" item is disabled only while the
// tab's bind has not landed (`rc_start` needs a live session), and says why.
//
// `SessionSidebar` is stubbed: the picker is one of the things that goes
// away, and it is not what is under test.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const Null = vi.hoisted(() => () => null);
vi.mock("./session-sidebar", () => ({ SessionSidebar: Null }));

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatHeader } from "./chat-header";

afterEach(cleanup);

function mount(props: { empty?: boolean; sessionId?: string; onForkSession?: () => void }) {
  const noop = () => {};
  return render(
    <ChatHeader
      tabId="tab-1"
      title="New chat"
      sessionId={props.sessionId ?? ""}
      roleFilter="all"
      onRoleFilterChange={noop}
      pinScopeKey="tab:tab-1"
      onJumpToPin={noop}
      bashPanelOpen={false}
      onToggleBash={noop}
      plansPanelOpen={false}
      onTogglePlans={noop}
      overviewOpen={false}
      onToggleOverview={noop}
      sidebarOpen={false}
      onToggleSidebar={noop}
      onNewSession={noop}
      onForkSession={props.onForkSession}
      empty={props.empty}
    />,
  );
}

async function openMore() {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

const menuItem = (name: string | RegExp) => screen.queryByRole("menuitem", { name });

describe("ChatHeader on the welcome screen (empty)", () => {
  it("keeps the overview toggle and the More menu, and nothing that needs a thread", () => {
    mount({ empty: true });

    expect(screen.getByRole("button", { name: "Thread overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Chat history" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByTitle("Switch session")).toBeNull();
  });

  it("offers only remote control in the menu, disabled with a reason until the session binds", async () => {
    mount({ empty: true, onForkSession: () => {} });
    await openMore();

    const start = menuItem("Remote control");
    expect(start).toBeTruthy();
    expect(start!.getAttribute("aria-disabled")).toBe("true");
    expect(start!.getAttribute("title")).toBe("Available once the agent has connected");

    expect(screen.queryByText("Filter messages")).toBeNull();
    expect(menuItem("Bash calls")).toBeNull();
    expect(menuItem("Plans")).toBeNull();
    expect(menuItem("Branch from here")).toBeNull();
  });

  it("enables remote control once the tab has a session", async () => {
    mount({ empty: true, sessionId: "sess-1" });
    await openMore();

    const start = menuItem("Remote control");
    expect(start!.getAttribute("aria-disabled")).toBeNull();
    expect(start!.getAttribute("title")).toBeNull();
  });
});

describe("ChatHeader beside a thread", () => {
  it("shows the full bar and the full menu", async () => {
    mount({ sessionId: "sess-1", onForkSession: () => {} });

    expect(screen.getByRole("button", { name: "Chat history" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
    expect(screen.getByTitle("Switch session")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Thread overview" })).toBeTruthy();

    await openMore();
    expect(screen.getByText("Filter messages")).toBeTruthy();
    expect(menuItem("Bash calls")).toBeTruthy();
    expect(menuItem("Plans")).toBeTruthy();
    expect(menuItem("Remote control")).toBeTruthy();
    expect(menuItem("Branch from here")).toBeTruthy();
  });
});
