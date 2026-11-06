// @vitest-environment happy-dom
//
// Clicking a file in a turn's changed-files card (or its "Open diff"): the
// review panel opens beside the session, in that turn's scope, at the file.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const toastInfo = vi.fn();
vi.mock("sonner", () => ({ toast: { info: (...a: unknown[]) => toastInfo(...a) } }));

const openSessionChanges = vi.fn();
vi.mock("@/features/git/lib/open-session-changes", () => ({
  openSessionChanges: (...a: unknown[]) => openSessionChanges(...a),
}));

import type { ChatMessage, ChatSession, ToolCallDisplay } from "@/types/agent";
import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "../stores/chat-store";
import { showTurnDiff } from "./show-turn-diff";

const edit = (id: string, path: string): ToolCallDisplay =>
  ({
    id,
    toolName: "Edit",
    kind: "edit",
    status: "completed",
    arguments: { file_path: `/repo/${path}`, old_string: "a", new_string: "b" },
    result: null,
    duration: null,
    locations: [],
  }) as ToolCallDisplay;

const message = (id: string, role: "user" | "assistant", toolCalls: ToolCallDisplay[] = []) =>
  ({
    id,
    role,
    content: "",
    toolCalls,
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-01T09:00:00Z",
    mode: "text",
  }) as ChatMessage;

function seed(acpSessionId: string | undefined) {
  useChatStore.setState((s) => ({
    ...s,
    sessions: {
      "tab-1": {
        id: "tab-1",
        acpSessionId,
        messages: [
          message("u1", "user"),
          message("a2", "assistant", [edit("c1", "src/a.ts"), edit("c2", "src/b.ts")]),
          message("u3", "user"),
          message("a4", "assistant"),
        ],
      } as unknown as ChatSession,
    },
  }));
}

beforeEach(() => {
  toastInfo.mockReset();
  openSessionChanges.mockReset();
  useAppStore.setState({ currentProject: { path: "/repo" } } as never);
  seed("acp-1");
});

describe("showTurnDiff", () => {
  it("opens the session's changes on the turn, at the file that was clicked", () => {
    expect(showTurnDiff("tab-1", { turnId: "t:a2", file: "/repo/src/b.ts" })).toBe(true);
    expect(openSessionChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/repo",
        sessionId: "acp-1",
        file: "src/b.ts",
        // The stable key, which the panel persists.
        turnId: "tc:c1",
      }),
    );
  });

  it("lands on the turn's first file for the card's Open diff", () => {
    showTurnDiff("tab-1", { turnId: "tc:c1" });
    expect(openSessionChanges.mock.calls[0][0].file).toBe("src/a.ts");
  });

  it("ignores a turn another chat holds, without a word", () => {
    expect(showTurnDiff("tab-2", { turnId: "t:a2" })).toBe(false);
    expect(showTurnDiff("tab-1", { turnId: "t:elsewhere" })).toBe(false);
    expect(openSessionChanges).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("shows the session's changes, and says why, for a turn with no recorded edits", () => {
    expect(showTurnDiff("tab-1", { turnId: "t:a4", file: "/repo/src/c.ts" })).toBe(true);
    const [opts] = openSessionChanges.mock.calls[0];
    expect(opts).toMatchObject({ sessionId: "acp-1", file: "src/c.ts" });
    expect(opts.turnId).toBeUndefined();
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("says why before the session is bound: the panel is keyed by it", () => {
    seed(undefined);
    expect(showTurnDiff("tab-1", { turnId: "t:a2" })).toBe(false);
    expect(openSessionChanges).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });
});
