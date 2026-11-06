// @vitest-environment happy-dom
//
// A vote is drawn the moment it is cast, replaced by the server's answer, and
// put back exactly as it was when the server refuses it.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Comment, CommentThreads } from "./comments-api";

const listMock = vi.hoisted(() => vi.fn());
const voteMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@/features/organisations/lib/use-org-directory", () => ({
  useOrgDirectory: () => ({ byId: new Map(), currentUserId: "u_me" }),
}));
vi.mock("./watch-queue", () => ({ queueFollow: vi.fn(async () => {}), queueUnfollow: vi.fn() }));
vi.mock("./comments-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./comments-api")>();
  return { ...real, comments: { ...real.comments, list: listMock, vote: voteMock } };
});

const { useSessionComments } = await import("./use-session-comments");

const c1: Comment = {
  id: "c1",
  sessionId: "ses_a",
  anchorKind: "message",
  anchorId: "row-1",
  parentId: null,
  authorId: "u_grace",
  guestName: null,
  body: "nice prompt",
  mentions: [],
  createdAt: "2026-10-19T10:00:00.000Z",
  editedAt: null,
  deletedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  votes: { up: ["u_grace"], down: [] },
};
const threads: CommentThreads = { byAnchor: { "row-1": [c1] }, session: [] };
const votesOf = (r: { current: ReturnType<typeof useSessionComments> }) =>
  r.current?.byAnchor["row-1"]?.[0].votes;

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(threads);
  voteMock.mockReset();
});

describe("voting through useSessionComments", () => {
  it("draws the vote at once, then takes the server's answer", async () => {
    let answer!: (c: Comment) => void;
    voteMock.mockReturnValue(new Promise<Comment>((r) => (answer = r)));
    const { result } = renderHook(() => useSessionComments("rp_1", "ses_a"));
    await act(async () => {});

    let done!: Promise<void>;
    act(() => {
      done = result.current!.actions.vote!("c1", 1);
    });
    expect(votesOf(result)).toEqual({ up: ["u_grace", "u_me"], down: [] });
    expect(voteMock).toHaveBeenCalledWith("rp_1", "ses_a", "c1", 1);

    await act(async () => {
      answer({ ...c1, votes: { up: ["u_grace", "u_me", "u_sam"], down: [] } });
      await done;
    });
    expect(votesOf(result)).toEqual({ up: ["u_grace", "u_me", "u_sam"], down: [] });
  });

  it("puts the comment back when the server refuses, and lets the caller say so", async () => {
    voteMock.mockRejectedValue(new Error("forbidden"));
    const { result } = renderHook(() => useSessionComments("rp_1", "ses_a"));
    await act(async () => {});
    await act(async () => {
      await expect(result.current!.actions.vote!("c1", -1)).rejects.toThrow("forbidden");
    });
    expect(votesOf(result)).toEqual({ up: ["u_grace"], down: [] });
  });
});
