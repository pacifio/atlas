import { describe, expect, it } from "vitest";
import { outwardApprovalOf } from "./outward-approval";

/** The body of a long reply: shortening it anywhere would show. */
const LONG = Array.from({ length: 300 }, (_, i) => `line ${i}: renamed the theme keys`).join("\n");

/** A permission's tool call as the wire carries an outward action's card. */
const replyCard = (overrides: Record<string, unknown> = {}) => ({
  toolCallId: "call-1",
  title: "Reply on Sam Lee's comment",
  kind: "other",
  status: "pending",
  rawInput: { comment: "k1", body: LONG },
  toolName: "atlas_org.org_comment_reply",
  content: ['Sam Lee, on their comment "can you check the path?" in Fix the theme importer', LONG],
  ...overrides,
});

describe("an outward action's approval card", () => {
  it("reads the title, the recipient and the whole body off the permission", () => {
    expect(outwardApprovalOf(replyCard())).toEqual({
      title: "Reply on Sam Lee's comment",
      recipient: 'Sam Lee, on their comment "can you check the path?" in Fix the theme importer',
      body: LONG,
    });
  });

  it("is only ever an organisation tool's card", () => {
    expect(outwardApprovalOf(replyCard({ toolName: "git push" }))).toBeNull();
    expect(outwardApprovalOf(replyCard({ toolName: "other.org_comment_reply" }))).toBeNull();
    expect(outwardApprovalOf(replyCard({ toolName: undefined }))).toBeNull();
  });

  it("keeps the plain card when the host could not say whom it reaches", () => {
    expect(outwardApprovalOf(replyCard({ content: undefined }))).toBeNull();
    expect(outwardApprovalOf(replyCard({ content: ["only one block"] }))).toBeNull();
  });
});
