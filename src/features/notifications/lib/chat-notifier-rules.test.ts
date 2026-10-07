import { describe, expect, it } from "vitest";
import type { ChatConversation, CommsMessage, OrgMemberProfile } from "@/features/comms/types";
import { chatPreview, classifyChatMessage, decideChatNotification } from "./chat-notifier-rules";
import type { NotificationEnv } from "./decide";

const member = (id: string, name: string): OrgMemberProfile => ({
  id,
  name,
  email: `${id}@x.dev`,
  role: "member",
});
const members = new Map([
  ["me", member("me", "Mo")],
  ["ann", member("ann", "Ann")],
  ["bob", member("bob", "Bob")],
]);
const ctx = { me: "me", members, orgId: "org-1" };

const conv = (over: Partial<ChatConversation>): ChatConversation => ({
  id: "c1",
  kind: "channel",
  name: "general",
  visibility: "public_org",
  workspace_ref_ids: [],
  created_by: "ann",
  created_at: 0,
  archived_at: null,
  seq: 0,
  member_ids: null,
  last_activity_seq: 0,
  ...over,
});
const msg = (over: Partial<CommsMessage>): CommsMessage => ({
  id: "m1",
  conv_id: "c1",
  seq: 1,
  author_id: "ann",
  body: "hello",
  reply_to_id: null,
  edited_at: null,
  created_at: 0,
  attachments: [],
  code_refs: [],
  draft_id: null,
  ...over,
});

const dm = conv({ kind: "dm", name: null, member_ids: ["me", "ann"] });
const group = conv({ kind: "group_dm", name: null, member_ids: ["me", "ann", "bob"] });

describe("classifyChatMessage", () => {
  it("notifies for a DM, titled by the sender", () => {
    expect(classifyChatMessage(msg({ body: "lunch?" }), dm, ctx)).toEqual({
      kind: "chat-dm",
      title: "Ann",
      body: "lunch?",
      target: { type: "chat-conversation", convId: "c1", orgId: "org-1" },
      dedupeKey: "m1",
    });
  });

  it("notifies for a group DM, naming the group", () => {
    const e = classifyChatMessage(msg({ author_id: "bob" }), group, ctx);
    expect(e?.kind).toBe("chat-dm");
    expect(e?.title).toBe("Bob · Ann & Bob");
  });

  it("notifies for an @mention in a channel, rendering the token as a name", () => {
    const e = classifyChatMessage(msg({ body: "ping <@me> and <@bob>" }), conv({}), ctx);
    expect(e?.kind).toBe("chat-mention");
    expect(e?.title).toBe("Ann · #general");
    expect(e?.body).toBe("ping @Mo and @Bob");
  });

  it("names an integration as one, never as an unknown member", () => {
    const e = classifyChatMessage(
      msg({
        author_id: "whk_1",
        author_kind: "webhook",
        author_name: "CI",
        author_via: "Deploy bot",
        body: "<@me> build 41 failed",
      }),
      conv({}),
      ctx,
    );
    expect(e?.title).toBe("CI · via Deploy bot (app) · #general");
  });

  it("counts @channel and @here as mentions", () => {
    expect(classifyChatMessage(msg({ body: "@channel standup" }), conv({}), ctx)).not.toBeNull();
    expect(classifyChatMessage(msg({ body: "@here anyone?" }), conv({}), ctx)).not.toBeNull();
  });

  it("is silent for a channel message without a mention of me", () => {
    expect(classifyChatMessage(msg({ body: "plain" }), conv({}), ctx)).toBeNull();
    expect(classifyChatMessage(msg({ body: "hey <@bob>" }), conv({}), ctx)).toBeNull();
  });

  it("never notifies for my own messages", () => {
    expect(classifyChatMessage(msg({ author_id: "me" }), dm, ctx)).toBeNull();
    expect(classifyChatMessage(msg({ author_id: "me", body: "<@me>" }), conv({}), ctx)).toBeNull();
  });

  it("is silent while me is unknown", () => {
    expect(classifyChatMessage(msg({}), dm, { ...ctx, me: "" })).toBeNull();
  });

  it("is silent for a deleted message or an unknown conversation", () => {
    expect(classifyChatMessage(msg({ deleted: true }), dm, ctx)).toBeNull();
    expect(classifyChatMessage(msg({}), undefined, ctx)).toBeNull();
  });

  it("describes an attachment-only message", () => {
    const attachments = [{ id: "a", filename: "f.png", content_type: "image/png", bytes: 1 }];
    expect(classifyChatMessage(msg({ body: "", attachments }), dm, ctx)?.body).toBe(
      "Sent an attachment",
    );
  });

  it("falls back to a placeholder for an unknown sender", () => {
    expect(classifyChatMessage(msg({ author_id: "zed" }), dm, ctx)?.title).toBe("Someone");
  });
});

describe("chatPreview", () => {
  it("collapses to one line and trims with an ellipsis", () => {
    expect(chatPreview("a\n\n b\tc", members)).toBe("a b c");
    const out = chatPreview("x".repeat(300), members);
    expect(out).toHaveLength(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("renders an unknown mention as Someone", () => {
    expect(chatPreview("hi <@ghost>", members)).toBe("hi @Someone");
  });
});

describe("decideChatNotification", () => {
  const env = (over: Partial<NotificationEnv> = {}): NotificationEnv => ({
    windowFocused: true,
    sinceInputMs: 0,
    targetVisible: false,
    projectActive: true,
    away: false,
    ...over,
  });

  it("toasts when the conversation is off screen, banners only when away", () => {
    const d = decideChatNotification(msg({}), dm, ctx, env());
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: false });
    const away = decideChatNotification(
      msg({}),
      dm,
      ctx,
      env({ windowFocused: false, away: true }),
    );
    expect(away?.channels.native).toBe(true);
    expect(away?.groupKey).toBe("chat:c1");
  });

  it("is silent when the conversation is on screen and being looked at", () => {
    expect(decideChatNotification(msg({}), dm, ctx, env({ targetVisible: true }))).toBeNull();
  });
});
