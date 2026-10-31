import { describe, expect, it } from "vitest";
import type { Comment } from "@/features/artifacts/lib/comments-api";
import { commentTotal } from "./session-sharing";

const comment = (id: string, deleted = false): Comment => ({
  id,
  sessionId: "s",
  anchorKind: "message",
  anchorId: "a",
  parentId: null,
  authorId: "u",
  guestName: null,
  body: deleted ? null : "hi",
  mentions: [],
  createdAt: "2026-10-01T00:00:00Z",
  editedAt: null,
  deletedAt: deleted ? "2026-10-02T00:00:00Z" : null,
  resolvedAt: null,
  resolvedBy: null,
});

describe("commentTotal", () => {
  it("counts the session's comments and every entry's, leaving out deleted ones", () => {
    expect(
      commentTotal({
        session: [comment("1"), comment("2", true)],
        byAnchor: { a: [comment("3")], b: [comment("4"), comment("5")] },
      }),
    ).toBe(4);
  });

  it("is zero for a session with none", () => {
    expect(commentTotal({ session: [], byAnchor: {} })).toBe(0);
  });
});
