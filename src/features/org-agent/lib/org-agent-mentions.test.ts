// `@` mentions: what a message sends beside its text, how a sent message is
// cut back into chips, and what a pasted Atlas link names.

import { describe, expect, it } from "vitest";

import { labelOf, mentionFromLink, mentionsToSend, segmentsOf } from "./org-agent-mentions";
import type { Mention } from "./org-agent-types";

const ada: Mention = { kind: "person", id: "u1", label: "Ada" };
const adaL: Mention = { kind: "person", id: "u2", label: "Ada Lovelace" };
const team: Mention = { kind: "conversation", id: "c1", label: "#team" };

describe("sending", () => {
  it("sends each mention once, in order, within the wire's bounds", () => {
    expect(mentionsToSend([ada, team, ada])).toEqual([ada, team]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: "person" as const,
      id: `u${i}`,
      label: `P${i}`,
    }));
    expect(mentionsToSend(many)).toHaveLength(20);
    expect(mentionsToSend([{ ...ada, label: "x".repeat(200) }])[0]!.label).toHaveLength(120);
  });

  it("makes a label one trimmed line, with a fallback for nothing", () => {
    expect(labelOf("  fix\n the   bug ", "Session")).toBe("fix the bug");
    expect(labelOf("   ", "Session")).toBe("Session");
    expect(labelOf("y".repeat(200), "S")).toHaveLength(120);
  });
});

describe("drawing a sent message", () => {
  it("cuts the text into words and chips, longest label first", () => {
    expect(segmentsOf("Ask @Ada Lovelace and @Ada in @#team", [ada, adaL, team])).toEqual([
      { kind: "text", text: "Ask " },
      { kind: "mention", text: "@Ada Lovelace", mention: adaL },
      { kind: "text", text: " and " },
      { kind: "mention", text: "@Ada", mention: ada },
      { kind: "text", text: " in " },
      { kind: "mention", text: "@#team", mention: team },
    ]);
  });

  it("does not read an email address or a message without mentions as chips", () => {
    expect(segmentsOf("mail ada@Ada.dev", [ada])).toEqual([
      { kind: "text", text: "mail ada@Ada.dev" },
    ]);
    expect(segmentsOf("plain", undefined)).toEqual([{ kind: "text", text: "plain" }]);
  });
});

describe("a pasted Atlas link", () => {
  it("names a session, a comment, a conversation, a message or an Ask by its ids", () => {
    expect(mentionFromLink("https://app.tryatlas.cc/timeline?workspace=w1&session=s1")).toEqual({
      kind: "session",
      id: "s1",
      label: "Session",
      within: ["w1"],
    });
    expect(mentionFromLink("/timeline?workspace=w1&session=s1&comment=cm1")).toEqual({
      kind: "comment",
      id: "cm1",
      label: "Comment",
      within: ["w1", "s1"],
    });
    expect(mentionFromLink("https://app.tryatlas.cc/chat?c=c1&m=m1")).toEqual({
      kind: "message",
      id: "m1",
      label: "Message",
      within: ["c1"],
    });
    expect(mentionFromLink("/agent?ask=a1")).toMatchObject({ kind: "ask", id: "a1" });
  });

  it("names nothing for another site, a link without ids, or words", () => {
    expect(mentionFromLink("https://evil.example/timeline?workspace=w&session=s")).toBeNull();
    expect(mentionFromLink("/timeline?workspace=w1")).toBeNull();
    expect(mentionFromLink("/agent?ask=new")).toBeNull();
    expect(mentionFromLink("ses-41")).toBeNull();
    expect(mentionFromLink("payments team")).toBeNull();
  });
});
