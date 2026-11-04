// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommsHomeView } from "./comms-home-view";
import type { ChatConversation, OrgMemberProfile } from "../../types";

const channel: ChatConversation = {
  id: "c1",
  kind: "channel",
  name: "general",
  visibility: "public_org",
  workspace_ref_ids: [],
  created_by: "me",
  created_at: 0,
  archived_at: null,
  seq: 1,
  member_ids: null,
  last_activity_seq: 1,
};

const sam: OrgMemberProfile = { id: "u2", name: "Sam", email: "sam@x.dev", role: "member" };

function show() {
  const onOpen = vi.fn();
  const onStartDm = vi.fn();
  render(
    <CommsHomeView
      conversations={[channel]}
      discoverable={[]}
      reads={new Map()}
      members={new Map([[sam.id, sam]])}
      online={[]}
      me="me"
      rosterPending={false}
      startingDmId={null}
      onOpen={onOpen}
      onStartDm={onStartDm}
      onJoin={() => {}}
      channelAction={null}
      dmAction={null}
    />,
  );
  return { onOpen, onStartDm };
}

afterEach(cleanup);

// The package row reports only the id; the view reads the click's modifiers
// itself, so ⌘-click must still reach `onOpen` as a new-tab open.
describe("CommsHomeView", () => {
  it("a plain click opens in place", () => {
    const { onOpen } = show();
    fireEvent.click(screen.getByRole("button", { name: "general" }));
    expect(onOpen).toHaveBeenCalledWith("c1", false);
  });

  it("⌘-click and Ctrl-click open in a new tab", () => {
    const { onOpen } = show();
    fireEvent.click(screen.getByRole("button", { name: "general" }), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "general" }), { ctrlKey: true });
    expect(onOpen.mock.calls).toEqual([
      ["c1", true],
      ["c1", true],
    ]);
  });

  it("a modifier does not stick to the next plain click", () => {
    const { onOpen } = show();
    fireEvent.click(screen.getByRole("button", { name: "general" }), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "general" }));
    expect(onOpen).toHaveBeenLastCalledWith("c1", false);
  });

  it("a contact row starts a DM with that member", () => {
    const { onStartDm } = show();
    fireEvent.click(screen.getByRole("button", { name: /Sam/ }));
    expect(onStartDm).toHaveBeenCalledWith("u2");
  });
});
