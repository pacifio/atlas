// @vitest-environment happy-dom
//
// The team chat footer icon carries a dot while the server counts anything
// unread, and a message landing elsewhere in the comms store does not
// re-render it.

import { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ locked: false as boolean }));
vi.mock("@/features/comms/lib/team-chat-access", () => ({
  useTeamAccess: () => (access.locked ? { locked: true, reason: "local-org" } : { locked: false }),
  unlockHint: () => undefined,
}));

import { HintGroup } from "@/ui/hint-group";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import type { ChatConversation } from "@/features/comms/types";
import { TeamChatButton } from "./sidebar-destinations";

const conv = { id: "c1" } as ChatConversation;
const read = (unread: number, mentions = 0) => ({
  conv_id: "c1",
  last_read_seq: 0,
  unread,
  mentions,
});

let renders = 0;
function mount() {
  return render(
    <Profiler id="team-chat" onRender={() => (renders += 1)}>
      <HintGroup>
        <TeamChatButton />
      </HintGroup>
    </Profiler>,
  );
}

beforeEach(() => {
  renders = 0;
  access.locked = false;
  useCommsStore.setState({ conversations: [conv], reads: [read(0)] });
});
afterEach(cleanup);

describe("TeamChatButton", () => {
  it("shows a dot while a conversation has unread messages or mentions", () => {
    mount();
    expect(screen.queryByTestId("team-chat-unread")).toBeNull();
    act(() => useCommsStore.setState({ reads: [read(2)] }));
    expect(screen.getByTestId("team-chat-unread")).toBeTruthy();
    act(() => useCommsStore.setState({ reads: [read(0, 1)] }));
    expect(screen.getByTestId("team-chat-unread")).toBeTruthy();
    act(() => useCommsStore.setState({ reads: [read(0)] }));
    expect(screen.queryByTestId("team-chat-unread")).toBeNull();
  });

  it("does not re-render on comms changes that leave the dot as it is", () => {
    mount();
    const before = renders;
    act(() => useCommsStore.setState({ messages: { c1: [] } }));
    act(() => useCommsStore.setState({ reads: [read(0)] }));
    expect(renders).toBe(before);
  });

  it("shows no dot while team chat is locked", () => {
    access.locked = true;
    useCommsStore.setState({ reads: [read(4)] });
    mount();
    expect(screen.queryByTestId("team-chat-unread")).toBeNull();
  });
});
