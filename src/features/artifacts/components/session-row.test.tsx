// @vitest-environment happy-dom
//
// The board row is the whole point of the new Timeline: the nav it replaced
// could say a title and a time, and every other fact about a run — which
// model, whose work, what it changed — meant opening the Session. These cases
// pin the facts a row must carry, and the two places it used to print a
// separator with nothing either side of it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BoardSession } from "../types";
import { EMPTY_DIRECTORY } from "../lib/author-directory";

// The row's avatar pulls in the auth + explorer stores, which subscribe to
// Tauri at import. There is no Tauri here, and an unmocked `listen` rejects
// after the test has already passed.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
// The live state draws a `thinking-orbs` canvas; happy-dom has no 2D context
// and the orb is not what these cases are about.
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));

const { SessionRow } = await import("./session-row");

function session(over: Partial<BoardSession> = {}): BoardSession {
  return {
    id: "s1",
    title: "fix the caret padding",
    agent: "claude-code",
    model: "claude-opus-5-5",
    source: "acp",
    startedAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:30:00Z",
    lastActivityAt: "2026-10-14T10:30:00Z",
    activeSeconds: 600,
    wallSeconds: 1800,
    messageCount: 4,
    toolCallCount: 9,
    checkpointCount: 3,
    branches: ["0.4.1"],
    insertions: 120,
    deletions: 8,
    filesTouched: 2,
    totalTokens: 138500,
    inputTokens: 600,
    outputTokens: 1200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: null,
    contextSize: null,
    needsAttention: false,
    attentionReason: null,
    projectPath: "/repo",
    projectName: "atlas",
    synced: false,
    origin: "local",
    remoteProjectId: null,
    authorId: null,
    ...over,
  };
}

function row(over: Partial<BoardSession> = {}, onOpen = vi.fn()) {
  render(
    <SessionRow
      session={session(over)}
      directory={EMPTY_DIRECTORY}
      selected={false}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}

afterEach(cleanup);

describe("SessionRow", () => {
  it("carries the facts you pick a session by", () => {
    row();
    expect(screen.getByText("fix the caret padding")).toBeTruthy();
    // The raw model id, not a prettified name: you match it against the
    // composer and the bill, and both spell it this way.
    expect(screen.getByText("claude-opus-5-5")).toBeTruthy();
    expect(screen.getByText("0.4.1")).toBeTruthy();
    expect(screen.getByText("138.5K tok")).toBeTruthy();
    expect(screen.getByText("atlas")).toBeTruthy();
    expect(screen.getByText("3 checkpoints")).toBeTruthy();
    expect(screen.getByText("+120")).toBeTruthy();
    expect(screen.getByText("−8")).toBeTruthy();
  });

  it("says a session changed nothing rather than showing an empty count", () => {
    row({ checkpointCount: 0, insertions: 0, deletions: 0 });
    expect(screen.getByText("No checkpoints")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
  });

  it("opens no dangling separator when a session has no branch", () => {
    // A session captured outside a checkout has no branch, and the line used
    // to open with a `·` standing in front of the token count.
    row({ branches: [] });
    const line = screen.getByText("138.5K tok").parentElement!;
    expect(line.textContent?.trimStart().startsWith("·")).toBe(false);
    // One separator, between tokens and project — not two.
    expect(line.textContent?.match(/·/g) ?? []).toHaveLength(1);
  });

  it("names its state for the pointer and for a screen reader", () => {
    cleanup();
    row({ needsAttention: true });
    expect(screen.getByRole("img", { name: "Needs attention" })).toBeTruthy();
    cleanup();
    row({ source: "external_jsonl" });
    expect(screen.getByRole("img", { name: "Imported" })).toBeTruthy();
    cleanup();
    // Only a running session moves; everything at rest is a still dot.
    row({ updatedAt: new Date().toISOString() });
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
  });

  it("opens on click", () => {
    const onOpen = row();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
