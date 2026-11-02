// @vitest-environment happy-dom
//
// The title bar's session group is Details alone (the pins pill joins it only
// while something is pinned, the remote-control pill only while the session
// has a room). Nothing else lives in it, and nothing follows
// the window's panel toggle: team chat left the bar for the sidebar footer and
// the surfaces pane, the session's actions are its sidebar row's menu, and the
// Bash calls and Plans panels open from the Details card.

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@/features/session-context/components/session-details-button", () => ({
  SessionDetailsButton: () => <button type="button" aria-label="Session details" />,
}));
import { HintGroup } from "@/ui/hint-group";
import { useChatStore } from "../stores/chat-store";
import { useRcStore } from "../stores/rc-store";
import { SessionHeaderControls } from "./session-header";

afterEach(cleanup);

describe("the session group", () => {
  it("is Details alone while nothing is pinned", () => {
    render(
      <HintGroup>
        <SessionHeaderControls
          tabId="t1"
          scope="t:t1"
          docked={false}
          stageRef={createRef<HTMLElement>()}
          pinScopeKey="t1"
          onJumpToPin={() => {}}
        />
      </HintGroup>,
    );
    const group = document.querySelector("[data-session-controls]")!;
    const names = [...group.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Session details"]);
  });

  it("is joined by the remote-control pill while the session has a room", () => {
    useChatStore.setState({
      sessions: {},
      pendingPermissions: {},
      queues: {},
      activeSessionId: null,
    });
    useChatStore.getState().actions.createSession("t1", "codex");
    useChatStore.getState().actions.setAcpBinding("t1", "agent-1", "sess-1", "/tmp/p");
    useRcStore.setState({ bySession: {} });
    useRcStore.getState().actions.upsert({
      sessionId: "sess-1",
      roomId: "01ROOM",
      scope: null,
      viewerUrl: "https://x",
      state: "live",
      ownerOnline: true,
      viewers: 0,
      driver: { id: "owner", name: null, isOwner: true, lost: false },
      pending: [],
      memberTier: "view",
      lastError: null,
      endReason: null,
    });
    render(
      <HintGroup>
        <SessionHeaderControls
          tabId="t1"
          scope="t:t1"
          docked={false}
          stageRef={createRef<HTMLElement>()}
          pinScopeKey="t1"
          onJumpToPin={() => {}}
        />
      </HintGroup>,
    );
    const group = document.querySelector("[data-session-controls]")!;
    const names = [...group.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Remote control", "Session details"]);
  });
});
