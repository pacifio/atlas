import { describe, expect, it } from "vitest";

import type { OrgMember } from "@/features/auth/lib/auth-api";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import type { Comment } from "../lib/comments-api";
import { facesOf, MAX_FACES } from "./comment-thread";
import { commenterName } from "@/components/commenter-avatar";

function member(userId: string, name: string): OrgMember {
  return {
    // Deliberately different from `userId`: a directory keyed by the membership
    // id compiles and matches nothing, which is the bug this button had.
    id: `mem_${userId}`,
    userId,
    name,
    email: `${userId}@example.invalid`,
    role: "member",
    createdAt: null,
    avatarPath: null,
  } as OrgMember;
}

function directory(...members: OrgMember[]): OrgDirectory {
  return { byId: new Map(members.map((m) => [m.userId, m])), currentUserId: null };
}

function comment(over: Partial<Comment> & { id: string; authorId: string }): Comment {
  return {
    sessionId: "ses_1",
    anchorKind: "message",
    anchorId: "msg_1",
    parentId: null,
    guestName: null,
    body: "hello",
    mentions: [],
    createdAt: "2026-09-20T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

const ROSTER = directory(
  member("u1", "Ada Lovelace"),
  member("u2", "Grace Hopper"),
  member("u3", "Alan Turing"),
  member("u4", "Katherine Johnson"),
);

/** What a face prints beside it, so the cases read as names. */
const name = (c: { authorId: string; guestName: string | null }) => commenterName(c, ROSTER);

describe("facesOf", () => {
  it("shows one face per person, not one per comment", () => {
    // A thread where one person wrote five times is not five people.
    const faces = facesOf(
      [
        comment({ id: "c1", authorId: "u1" }),
        comment({ id: "c2", authorId: "u1" }),
        comment({ id: "c3", authorId: "u1" }),
      ],
      ROSTER,
    );
    expect(faces).toHaveLength(1);
    expect(name(faces[0]!)).toBe("Ada Lovelace");
  });

  it("caps at three and prefers the most recent speakers", () => {
    // Only three fit, so they should be the people still talking rather than
    // whoever happened to open the thread.
    const faces = facesOf(
      [
        comment({ id: "c1", authorId: "u1" }),
        comment({ id: "c2", authorId: "u2" }),
        comment({ id: "c3", authorId: "u3" }),
        comment({ id: "c4", authorId: "u4" }),
      ],
      ROSTER,
    );
    expect(faces).toHaveLength(MAX_FACES);
    expect(faces.map(name)).toEqual(["Katherine Johnson", "Alan Turing", "Grace Hopper"]);
  });

  it("keys the avatar on the human, not the membership", () => {
    // The avatar's colour derives from the id it is given: the membership id
    // would recolour the same person in every Organisation they belong to.
    const [face] = facesOf([comment({ id: "c1", authorId: "u1" })], ROSTER);
    expect(face!.authorId).toBe("u1");
  });

  it("leaves out anyone the roster cannot name", () => {
    // A departed colleague has no photo and no initials to draw — a blank
    // circle in the stack says less than one fewer circle.
    expect(facesOf([comment({ id: "c1", authorId: "u_gone" })], ROSTER)).toHaveLength(0);
  });

  it("shows a guest as a guest, never as the member whose id they share", () => {
    // A guest IS a face — they have generated art rather than a photo, which
    // is why they are in the stack at all now. What must never happen is one
    // being drawn as the member whose id theirs collides with.
    const [face] = facesOf(
      [comment({ id: "c1", authorId: "u1", guestName: "Someone outside" })],
      ROSTER,
    );
    expect(face).toBeDefined();
    expect(face!.guestName).toBe("Someone outside");
    expect(name(face!)).toBe("Someone outside");
    expect(name(face!)).not.toBe("Ada Lovelace");
  });

  it("ignores deleted comments", () => {
    // The row survives so replies keep their places, but its author is no
    // longer part of the visible conversation.
    const faces = facesOf(
      [
        comment({ id: "c1", authorId: "u1", deletedAt: "2026-09-20T11:00:00.000Z" }),
        comment({ id: "c2", authorId: "u2" }),
      ],
      ROSTER,
    );
    expect(faces.map(name)).toEqual(["Grace Hopper"]);
  });
});
