import { describe, expect, it } from "vitest";
import {
  aggregateReactions,
  conversationTitle,
  groupMessages,
  isNewDay,
  utf8Bytes,
} from "./derive";
import { parseMentions } from "../types";
import type { ChatConversation, ChatReaction, CommsMessage, OrgMemberProfile } from "../types";

const member = (id: string, name: string): OrgMemberProfile => ({
  id,
  name,
  email: `${id}@example.com`,
  role: "member",
});

const members = new Map([
  ["u_a", member("u_a", "Ada Lovelace")],
  ["u_b", member("u_b", "Grace Hopper")],
  ["u_c", member("u_c", "Alan Turing")],
]);

const msg = (over: Partial<CommsMessage> & Pick<CommsMessage, "id">): CommsMessage => ({
  conv_id: "c1",
  seq: 1,
  author_id: "u_a",
  body: "hi",
  reply_to_id: null,
  edited_at: null,
  created_at: 1788170400000,
  attachments: [],
  code_refs: [],
  draft_id: null,
  ...over,
});

describe("aggregateReactions", () => {
  const rows: ChatReaction[] = [
    { message_id: "m1", user_id: "u_a", emoji: "🔥" },
    { message_id: "m1", user_id: "u_b", emoji: "🔥" },
    { message_id: "m1", user_id: "u_c", emoji: "👍" },
    { message_id: "m2", user_id: "u_a", emoji: "🎉" },
  ];

  it("derives counts from rows, since the server sends no aggregate", () => {
    const chips = aggregateReactions(rows, "m1", "u_c");
    expect(chips.map((c) => [c.emoji, c.count])).toEqual([
      ["🔥", 2],
      ["👍", 1],
    ]);
  });

  it("marks the chip the current user is part of", () => {
    const chips = aggregateReactions(rows, "m1", "u_a");
    expect(chips.find((c) => c.emoji === "🔥")?.mine).toBe(true);
    expect(chips.find((c) => c.emoji === "👍")?.mine).toBe(false);
  });

  it("ignores rows belonging to other messages", () => {
    expect(aggregateReactions(rows, "m2", "u_a")).toHaveLength(1);
  });

  it("orders by first appearance so chips do not reshuffle", () => {
    const reordered = [rows[2], rows[0], rows[1]];
    expect(aggregateReactions(reordered, "m1", "u_a").map((c) => c.emoji)).toEqual(["👍", "🔥"]);
  });
});

describe("groupMessages", () => {
  it("stacks consecutive messages from one author inside the window", () => {
    const groups = groupMessages(
      [msg({ id: "m1", created_at: 1788170400000 }), msg({ id: "m2", created_at: 1788170460000 })],
      "u_b",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
  });

  it("breaks the stack when the author changes", () => {
    const groups = groupMessages([msg({ id: "m1" }), msg({ id: "m2", author_id: "u_b" })], "u_b");
    expect(groups).toHaveLength(2);
  });

  it("breaks the stack once the time window lapses", () => {
    const groups = groupMessages(
      [msg({ id: "m1", created_at: 1788170400000 }), msg({ id: "m2", created_at: 1788172200000 })],
      "u_b",
    );
    expect(groups).toHaveLength(2);
  });

  it("gives a reply its own stack so the quoted parent gets a head", () => {
    const groups = groupMessages(
      [
        msg({ id: "m1", created_at: 1788170400000 }),
        msg({ id: "m2", created_at: 1788170430000, reply_to_id: "m1" }),
      ],
      "u_b",
    );
    expect(groups).toHaveLength(2);
  });

  it("breaks the stack across midnight so the day divider can render", () => {
    // The divider is drawn BETWEEN groups. Two messages minutes apart either
    // side of midnight used to stay in one group, which suppressed it entirely.
    //
    // Local-time components, not a UTC string: `crossesDay` compares local
    // calendar dates, so a fixture pinned to UTC midnight only straddles a day
    // when the machine's zone IS UTC — anywhere else both instants land on the
    // same date and the assertion fails.
    const groups = groupMessages(
      [
        msg({ id: "m1", created_at: new Date(2026, 7, 31, 23, 59).getTime() }),
        msg({ id: "m2", created_at: new Date(2026, 8, 1, 0, 1).getTime() }),
      ],
      "u_b",
    );
    expect(groups).toHaveLength(2);
    expect(isNewDay(groups[0].messages[0], groups[1].messages[0])).toBe(true);
  });

  it("marks own groups from the author id", () => {
    expect(groupMessages([msg({ id: "m1", author_id: "u_a" })], "u_a")[0].own).toBe(true);
    expect(groupMessages([msg({ id: "m1", author_id: "u_a" })], "u_b")[0].own).toBe(false);
  });
});

describe("conversationTitle", () => {
  const base: ChatConversation = {
    id: "c1",
    kind: "channel",
    name: "general",
    visibility: "public_org",
    workspace_ref_ids: [],
    created_by: "u_a",
    created_at: 0,
    archived_at: null,
    seq: 1,
    member_ids: null,
    last_activity_seq: 1,
  };

  it("uses the name for a channel", () => {
    expect(conversationTitle(base, members, "u_a")).toBe("general");
  });

  it("names a DM after the other person, never yourself", () => {
    const dm = { ...base, kind: "dm" as const, name: null, member_ids: ["u_a", "u_b"] };
    expect(conversationTitle(dm, members, "u_a")).toBe("Grace Hopper");
  });

  it("summarises a group DM past two names", () => {
    const gdm = {
      ...base,
      kind: "group_dm" as const,
      name: null,
      member_ids: ["u_a", "u_b", "u_c"],
    };
    expect(conversationTitle(gdm, members, "u_a")).toBe("Grace Hopper & Alan Turing");
  });
});

describe("parseMentions", () => {
  it("finds user tokens and reports their span", () => {
    const found = parseMentions("hey <@u_b> look");
    expect(found).toEqual([{ kind: "user", id: "u_b", start: 4, end: 10 }]);
  });

  it("recognises the broadcast forms", () => {
    expect(parseMentions("@here now").map((m) => m.kind)).toEqual(["here"]);
    expect(parseMentions("ping @channel").map((m) => m.kind)).toEqual(["channel"]);
  });

  it("does not treat an email as a broadcast mention", () => {
    expect(parseMentions("mail me at a@channel.com")).toEqual([]);
  });

  it("returns mentions in document order", () => {
    expect(parseMentions("@here and <@u_a>").map((m) => m.id)).toEqual(["here", "u_a"]);
  });
});

describe("utf8Bytes", () => {
  it("counts bytes, not characters — the limit the server enforces", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("🔥")).toBe(4);
    expect(utf8Bytes("日本")).toBe(6);
  });
});

describe("isNewDay", () => {
  it("is true for the first message", () => {
    expect(isNewDay(undefined, msg({ id: "m1" }))).toBe(true);
  });

  it("is false within the same calendar day", () => {
    expect(
      isNewDay(
        msg({ id: "m1", created_at: 1788138000000 }),
        msg({ id: "m2", created_at: 1788141600000 }),
      ),
    ).toBe(false);
  });
});
