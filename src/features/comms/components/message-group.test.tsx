// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The transcript stays quiet: a new message, a reaction or a presence flip
 * re-renders only the rows it touches. The body is the cheapest place to count
 * row renders — every live row renders exactly one.
 */
const bodyRenders = new Map<string, number>();
vi.mock("./message-body", () => ({
  MessageBody: ({ body }: { body: string }) => {
    bodyRenders.set(body, (bodyRenders.get(body) ?? 0) + 1);
    return <p>{body}</p>;
  },
}));

import { MessageGroup } from "./message-group";
import { useCommsStore } from "../stores/comms-store";
import type { CommsMessage, OrgMemberProfile } from "../types";

const ada: OrgMemberProfile = { id: "u_ada", name: "Ada", email: "ada@x.test", role: "member" };
const bob: OrgMemberProfile = { id: "u_bob", name: "Bob", email: "bob@x.test", role: "member" };
const members = new Map([
  [ada.id, ada],
  [bob.id, bob],
]);

function message(id: string, extra: Partial<CommsMessage> = {}): CommsMessage {
  return {
    id,
    conv_id: "c1",
    seq: Number(id.slice(1)),
    author_id: ada.id,
    body: `body ${id}`,
    reply_to_id: null,
    edited_at: null,
    created_at: 1,
    attachments: [],
    code_refs: [],
    draft_id: null,
    status: "sent",
    ...extra,
  };
}

const noop = () => {};
const callbacks = {
  onReply: noop,
  onEdit: noop,
  onDelete: noop,
  onReact: noop,
  onPin: noop,
  onJump: noop,
};

function group(messages: CommsMessage[], own = false) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return (
    <MessageGroup
      messages={messages}
      own={own}
      author={ada}
      members={members}
      me="u_ada"
      lookup={(id) => byId.get(id)}
      {...callbacks}
      showAuthor
    />
  );
}

beforeEach(() => {
  bodyRenders.clear();
  useCommsStore.setState({ reactionsByMessage: {}, online: [], pinned: [] });
});

afterEach(() => {
  cleanup();
});

describe("MessageGroup re-renders", () => {
  const base = [message("m1"), message("m2"), message("m3", { reply_to_id: "m1" })];

  it("re-renders only the row whose reactions changed", () => {
    render(group(base));
    bodyRenders.clear();
    act(() => {
      useCommsStore.setState({
        reactionsByMessage: { m2: [{ message_id: "m2", user_id: bob.id, emoji: "👍" }] },
      });
    });
    expect([...bodyRenders.keys()]).toEqual(["body m2"]);
    expect(screen.getByText("👍")).toBeTruthy();
  });

  it("appending a message with a new lookup re-renders only the new row", () => {
    const { rerender } = render(group(base));
    bodyRenders.clear();
    rerender(group([...base, message("m4")]));
    expect([...bodyRenders.keys()]).toEqual(["body m4"]);
  });

  it("a stranger's presence flip re-renders nothing", () => {
    render(group(base));
    bodyRenders.clear();
    act(() => {
      useCommsStore.setState({ online: [bob.id] });
    });
    expect(bodyRenders.size).toBe(0);
  });

  it("a deleted message shows the tombstone and offers no Edit", async () => {
    const { container } = render(group([message("m1", { deleted: true })], true));
    expect(screen.getByText("Message deleted")).toBeTruthy();
    fireEvent.mouseEnter(container.querySelector('[data-msg-id="m1"]') as Element);
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);
    expect(await screen.findByText("Copy text")).toBeTruthy();
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
  });
});
