// Where an answer may point. The rule is closed: a handle this Ask's tools
// returned, or one of Atlas's own routes, and nothing else — so a model that
// read a hostile comment cannot be made to link anyone off-app. And each
// place opens in THIS app, not the browser, where the desktop has it.

import { describe, expect, it } from "vitest";

import {
  HANDLE_PATTERN,
  cardKey,
  cardTarget,
  handleIndex,
  isAtlasRoute,
  mentionTarget,
  routeTarget,
  targetForHandle,
} from "./org-agent-links";
import type { Card, Mention } from "./org-agent-types";

const session: Card = {
  kind: "session",
  workspace_id: "w1",
  session_id: "s1",
  handle: "ses-41",
  title: "Fix expiry",
  author: "Ada",
  agent: "claude-acp",
  started_at: 1,
  live: true,
};
const comment: Card = {
  kind: "comment",
  workspace_id: "w1",
  session_id: "s1",
  comment_id: "cm1",
  handle: "cm-7",
  author: "Bo",
  excerpt: "Why?",
};
const message: Card = {
  kind: "message",
  conv_id: "c1",
  message_id: "m1",
  author: "Ada",
  excerpt: "hi",
  at: 1,
};
const conversation: Card = {
  kind: "conversation",
  conv_id: "c1",
  conv_kind: "channel",
  name: "team",
};
const project: Card = {
  kind: "project",
  workspace_id: "w1",
  handle: "wp-3",
  name: "Atlas",
  restricted: false,
};

describe("Atlas routes", () => {
  it("takes the app's own top-level routes", () => {
    for (const r of [
      "/timeline?workspace=w&session=s",
      "/chat?c=1",
      "/projects/wp-3",
      "/agent?ask=a1",
      "/space/c1",
      "/rc/rooms/r1",
    ]) {
      expect(isAtlasRoute(r), r).toBe(true);
    }
  });

  it("refuses anything that could leave the app", () => {
    for (const r of [
      "https://evil.example",
      "//evil.example/timeline",
      "/\\evil.example",
      "javascript:alert(1)",
      "/timelinex",
      "/timeline\u0000//evil",
      "/settings",
      "",
    ]) {
      expect(isAtlasRoute(r), JSON.stringify(r)).toBe(false);
    }
  });

  it("turns a route into the desktop place it names", () => {
    expect(routeTarget("/timeline?workspace=w1&session=s1&comment=cm1")).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
      commentId: "cm1",
    });
    expect(routeTarget("/chat?c=c1&m=m1")).toEqual({
      kind: "conversation",
      convId: "c1",
      messageId: "m1",
    });
    expect(routeTarget("/space/c1")).toEqual({ kind: "space", convId: "c1" });
    expect(routeTarget("/agent?ask=a9")).toEqual({ kind: "ask", askId: "a9" });
    expect(routeTarget("/agent?view=loops")).toEqual({ kind: "loops" });
    // No desktop page of its own: the web app.
    expect(routeTarget("/projects/wp-3")).toEqual({ kind: "web", route: "/projects/wp-3" });
    expect(routeTarget("/timeline")).toEqual({ kind: "web", route: "/timeline" });
    expect(routeTarget("https://evil.example")).toBeNull();
  });
});

describe("handles", () => {
  it("finds handles at word boundaries only", () => {
    const found = (s: string) => [...s.matchAll(HANDLE_PATTERN)].map((m) => m[0]);
    expect(found("see ses-41, wp-3 and cm-7; also fact-2")).toEqual([
      "ses-41",
      "wp-3",
      "cm-7",
      "fact-2",
    ]);
    expect(found("conv:01ABC and msg:x_1")).toEqual(["conv:01ABC", "msg:x_1"]);
    expect(found("aws-1 wp-12a ses-0 xses-4")).toEqual([]);
  });

  it("links a handle only when a tool returned it to this member", () => {
    const index = handleIndex([session, comment, message, conversation, project]);
    expect(targetForHandle("ses-41", index)).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
    });
    expect(targetForHandle("cm-7", index)).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
      commentId: "cm1",
    });
    expect(targetForHandle("msg:m1", index)).toEqual({
      kind: "conversation",
      convId: "c1",
      messageId: "m1",
    });
    expect(targetForHandle("conv:c1", index)).toEqual({ kind: "conversation", convId: "c1" });
    // Made up, or copied from something it read: text.
    expect(targetForHandle("ses-999", index)).toBeNull();
    expect(targetForHandle("cm-1", index)).toBeNull();
  });

  it("links a project handle without a card: its page reveals nothing to a reader who cannot open it", () => {
    expect(targetForHandle("wp-12", new Map())).toEqual({ kind: "web", route: "/projects/wp-12" });
  });
});

describe("cards", () => {
  it("opens each kind where the desktop keeps it", () => {
    expect(cardTarget(session)).toEqual({ kind: "session", workspaceId: "w1", sessionId: "s1" });
    expect(
      cardTarget({
        kind: "checkpoint",
        workspace_id: "w1",
        session_id: "s1",
        commit_sha: "abc",
        branch: "main",
        files: 1,
        plus: 1,
        minus: 0,
      }),
    ).toEqual({ kind: "session", workspaceId: "w1", sessionId: "s1", commitSha: "abc" });
    expect(cardTarget(comment)).toMatchObject({ kind: "session", commentId: "cm1" });
    expect(cardTarget(conversation)).toEqual({ kind: "conversation", convId: "c1" });
    expect(cardTarget(message)).toEqual({ kind: "conversation", convId: "c1", messageId: "m1" });
    expect(cardTarget({ kind: "space_page", conv_id: "c1", page_id: "p1", name: "Plan" })).toEqual({
      kind: "space",
      convId: "c1",
      pageId: "p1",
    });
    expect(cardTarget({ kind: "loop", loop_id: "l1", name: "Digest" })).toEqual({ kind: "loops" });
    expect(cardTarget(project)).toEqual({ kind: "web", route: "/projects/wp-3" });
    expect(cardTarget({ kind: "link", route: "/chat?c=c1", label: "x" })).toEqual({
      kind: "conversation",
      convId: "c1",
    });
    expect(cardTarget({ kind: "link", route: "https://evil.example", label: "x" })).toBeNull();
    expect(cardTarget({ kind: "person", user_id: "u1", name: "Ada" })).toBeNull();
    expect(cardTarget({ kind: "fact", fact_id: "f1", handle: "fact-1", text: "x" })).toBeNull();
  });

  it("keys a card by the record it names, so one record found twice draws once", () => {
    expect(cardKey(session)).toBe(cardKey({ ...session, title: "renamed" }));
    expect(cardKey(session)).not.toBe(cardKey(comment));
  });
});

describe("mention chips", () => {
  const m = (kind: Mention["kind"], extra: Partial<Mention> = {}): Mention => ({
    kind,
    id: "x1",
    label: "X",
    ...extra,
  });
  it("open what they name, built from ids only", () => {
    expect(mentionTarget(m("person"))).toBeNull();
    expect(mentionTarget(m("conversation"))).toEqual({ kind: "conversation", convId: "x1" });
    expect(mentionTarget(m("message", { within: ["c1"] }))).toEqual({
      kind: "conversation",
      convId: "c1",
      messageId: "x1",
    });
    expect(mentionTarget(m("message"))).toBeNull();
    expect(mentionTarget(m("session", { within: ["w1"] }))).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "x1",
    });
    expect(mentionTarget(m("comment", { within: ["w1", "s1"] }))).toEqual({
      kind: "session",
      workspaceId: "w1",
      sessionId: "s1",
      commentId: "x1",
    });
    expect(mentionTarget(m("ask"))).toEqual({ kind: "ask", askId: "x1" });
    expect(mentionTarget(m("loop"))).toEqual({ kind: "loops" });
    expect(mentionTarget(m("space_page"))).toEqual({ kind: "space", convId: "x1" });
    expect(mentionTarget(m("project", { handle: "wp-3" }))).toEqual({
      kind: "web",
      route: "/projects/wp-3",
    });
    expect(mentionTarget(m("rc_room"))).toEqual({ kind: "web", route: "/rc/rooms/x1" });
  });
});
