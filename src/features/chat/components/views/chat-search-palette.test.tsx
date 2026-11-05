// @vitest-environment happy-dom
//
// ⌘F over a session: only the user's own messages, filtered as they type,
// ↓/Enter jumps to the original index and closes, Esc closes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage } from "@/types/agent";
import { ChatSearchPalette } from "./chat-search-palette";

afterEach(cleanup);

const msg = (id: string, role: "user" | "assistant", content: string) =>
  ({
    id,
    role,
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-11-04T10:00:00Z",
  }) as unknown as ChatMessage;

const MESSAGES = [
  msg("a", "user", "Fix the login race"),
  msg("b", "assistant", "Done — the login race is fixed"),
  msg("c", "user", "Now bump the schema"),
];

describe("ChatSearchPalette", () => {
  it("lists user messages only, and ↓ Enter jumps to the original index", async () => {
    const onJump = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ChatSearchPalette open onOpenChange={onOpenChange} messages={MESSAGES} onJump={onJump} />,
    );
    const input = screen.getByPlaceholderText("Find a question you asked…");
    expect(screen.queryByText(/Done — the login/)).toBeNull();
    await userEvent.type(input, "{ArrowDown}{Enter}");
    expect(onJump).toHaveBeenCalledWith(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("filters as you type, and Esc closes", async () => {
    const onOpenChange = vi.fn();
    render(
      <ChatSearchPalette open onOpenChange={onOpenChange} messages={MESSAGES} onJump={() => {}} />,
    );
    const input = screen.getByPlaceholderText("Find a question you asked…");
    await userEvent.type(input, "schema");
    expect(screen.queryByText("Fix the login race")).toBeNull();
    expect(screen.getByText("Now bump the schema")).toBeTruthy();
    await userEvent.type(input, "{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
