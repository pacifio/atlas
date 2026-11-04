// A session still live in another process (a terminal) cannot be deleted from
// here: Rust refuses it, so the sidebar never asks the question at all.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
const confirmDeleteChat = vi.hoisted(() => vi.fn(async () => true));
const deleteThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/features/chat/lib/confirm-delete-chat", () => ({ confirmDeleteChat }));
vi.mock("@/features/chat/lib/history-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/lib/history-api")>()),
  deleteThread,
}));

import { deleteSession } from "./sidebar-actions";

const session = (liveElsewhere: boolean) =>
  ({ threadId: "t1", sessionId: "s1", title: "Fix it", liveElsewhere }) as never;

beforeEach(() => {
  confirmDeleteChat.mockClear();
  deleteThread.mockClear();
});

describe("deleteSession", () => {
  it("does nothing for a session live in another process", async () => {
    await deleteSession(session(true));
    expect(confirmDeleteChat).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  it("asks, then deletes, a session that is not", async () => {
    await deleteSession(session(false));
    expect(confirmDeleteChat).toHaveBeenCalledWith("Fix it");
    expect(deleteThread).toHaveBeenCalledWith("t1");
  });
});
