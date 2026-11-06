// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Comment, CommentThreads } from "./comments-api";

const listMock = vi.hoisted(() => vi.fn());
const followMock = vi.hoisted(() => vi.fn(async () => {}));
const unfollowMock = vi.hoisted(() => vi.fn(async () => {}));
const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/features/organisations/lib/use-org-directory", () => ({
  useOrgDirectory: () => ({ members: [] }),
}));
vi.mock("./watch-queue", () => ({ queueFollow: followMock, queueUnfollow: unfollowMock }));
vi.mock("./comments-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./comments-api")>();
  return { ...real, comments: { ...real.comments, list: listMock } };
});

const { useSessionComments } = await import("./use-session-comments");

function comment(sessionId: string, id: string): Comment {
  return {
    id,
    sessionId,
    anchorKind: "message",
    anchorId: "row-1",
    parentId: null,
    authorId: "user_ada",
    guestName: null,
    body: `on ${sessionId}`,
    mentions: [],
    createdAt: "2026-09-20T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
  };
}

const threadsOf = (sessionId: string): CommentThreads => ({
  byAnchor: { "row-1": [comment(sessionId, `c-${sessionId}`)] },
  session: [],
});

/** A promise and the hand that settles it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  listMock.mockReset();
  followMock.mockClear();
  unfollowMock.mockClear();
  invokeMock.mockClear();
});

describe("useSessionComments", () => {
  /// Switching Sessions must not show the previous one's comments while the
  /// next list is in flight (or forever, when it hangs).
  it("starts a different Session empty, before its own list answers", async () => {
    const b = deferred<CommentThreads>();
    listMock.mockImplementation(async (_p: string, s: string) =>
      s === "ses_a" ? threadsOf("ses_a") : b.promise,
    );
    const { result, rerender } = renderHook(({ session }) => useSessionComments("rp_1", session), {
      initialProps: { session: "ses_a" },
    });
    await act(async () => {});
    expect(result.current?.byAnchor["row-1"]?.[0].sessionId).toBe("ses_a");

    rerender({ session: "ses_b" });
    expect(result.current?.byAnchor).toEqual({});

    await act(async () => b.resolve(threadsOf("ses_b")));
    expect(result.current?.byAnchor["row-1"]?.[0].sessionId).toBe("ses_b");
  });

  /// A's answer arriving after the switch is dropped, not painted over B.
  it("drops a late answer for the Session it left", async () => {
    const a = deferred<CommentThreads>();
    listMock.mockImplementation(async (_p: string, s: string) =>
      s === "ses_a" ? a.promise : { byAnchor: {}, session: [] },
    );
    const { result, rerender } = renderHook(({ session }) => useSessionComments("rp_1", session), {
      initialProps: { session: "ses_a" },
    });
    rerender({ session: "ses_b" });
    await act(async () => a.resolve(threadsOf("ses_a")));
    expect(result.current?.byAnchor).toEqual({});
  });

  /// A chat that is not on the server has no comment surface and makes no
  /// comments or follow calls at all.
  it("an unshared Session is null and never lists or follows", async () => {
    const { result } = renderHook(() => useSessionComments(null, null));
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
    expect(followMock).not.toHaveBeenCalled();
  });

  it("a failed list leaves no comments, asks once, and does not throw", async () => {
    listMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useSessionComments("rp_1", "ses_a"));
    await act(async () => {});
    expect(result.current?.byAnchor).toEqual({});
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  /// Rapid A → B → A: every follow is paired with an unfollow on the way out.
  it("pairs each follow with an unfollow across rapid switches", async () => {
    listMock.mockResolvedValue({ byAnchor: {}, session: [] });
    const { rerender, unmount } = renderHook(({ session }) => useSessionComments("rp_1", session), {
      initialProps: { session: "ses_a" },
    });
    rerender({ session: "ses_b" });
    rerender({ session: "ses_a" });
    unmount();
    await act(async () => {});
    const net = new Map<string, number>();
    for (const [, s] of followMock.mock.calls as unknown as [string, string][])
      net.set(s, (net.get(s) ?? 0) + 1);
    for (const [, s] of unfollowMock.mock.calls as unknown as [string, string][])
      net.set(s, (net.get(s) ?? 0) - 1);
    expect([...net.values()].every((n) => n === 0)).toBe(true);
    expect(followMock).toHaveBeenCalledTimes(3);
  });

  /// Edit sends only the body, and folds the server's answer — the one with
  /// `editedAt` stamped — into the thread in place.
  it("edits a comment's body and shows the server's edited row", async () => {
    listMock.mockResolvedValue(threadsOf("ses_a"));
    const edited = {
      ...comment("ses_a", "c-ses_a"),
      body: "fixed typo",
      editedAt: "2026-09-20T10:05:00.000Z",
    };
    invokeMock.mockImplementationOnce(async () => edited as never);
    const { result } = renderHook(() => useSessionComments("rp_1", "ses_a"));
    await act(async () => {});

    await act(async () => result.current?.actions.edit?.("c-ses_a", "fixed typo"));

    expect(invokeMock).toHaveBeenCalledWith("artifacts_cloud_comment_update", {
      projectId: "rp_1",
      sessionId: "ses_a",
      commentId: "c-ses_a",
      body: "fixed typo",
      resolved: null,
    });
    const row = result.current?.byAnchor["row-1"];
    expect(row).toHaveLength(1);
    expect(row?.[0]).toMatchObject({ body: "fixed typo", editedAt: "2026-09-20T10:05:00.000Z" });
  });
});
