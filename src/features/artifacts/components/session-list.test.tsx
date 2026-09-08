// @vitest-environment happy-dom
/**
 * The Timeline row's model column.
 *
 * `prettyModel` shortens the families it knows and returns the raw id for
 * everything else, so `google/gemini-3.1-pro-preview` reaches the row at its
 * full 29 characters. The cell is `justify-self-end`, which sizes it to
 * `fit-content`, and `truncate`'s `white-space: nowrap` puts its min-content at
 * the width of the whole string — a floor `fit-content` cannot go below. It came
 * out 192px wide in a 92px track and, anchored to the track's END, grew leftward
 * over the agent chip; the ellipsis never appeared, because the box was never
 * clipped.
 *
 * happy-dom has no layout engine, so this asserts the width cap rather than
 * measuring it — the cap is the whole fix, and its absence is the bug.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// `globals: false` in vitest.config.ts — auto-cleanup is not registered.
beforeEach(cleanup);

// The list drops the model column below `COMPACT_WIDTH`, and every happy-dom
// measurement is 0, so without these two the column under test never renders.
vi.mock("../lib/shared-resize-observer", () => ({ observeSize: () => () => {} }));
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 900 });

import { SessionList } from "./session-list";
import type { BoardSession } from "../types";

function session(overrides: Partial<BoardSession> = {}): BoardSession {
  return {
    id: "as-1",
    title: "Work",
    agent: "claude-code",
    model: null,
    source: "external_jsonl",
    startedAt: "2026-06-01T16:10:00.000Z",
    updatedAt: "2026-06-01T16:12:00.000Z",
    lastActivityAt: "2026-06-01T16:12:00.000Z",
    activeSeconds: 120,
    wallSeconds: 120,
    messageCount: 4,
    toolCallCount: 0,
    checkpointCount: 0,
    branches: [],
    insertions: 0,
    deletions: 0,
    filesTouched: 0,
    totalTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: null,
    contextSize: null,
    needsAttention: false,
    attentionReason: null,
    projectPath: "/tmp/atlas",
    projectName: "atlas",
    ...overrides,
  };
}

describe("SessionList model column", () => {
  it("keeps a long model name inside its column", () => {
    render(
      <SessionList
        sessions={[session({ model: "google/gemini-3.1-pro-preview" })]}
        loading={false}
        filtered={false}
        onOpen={() => {}}
      />,
    );

    const cell = screen.getByText("google/gemini-3.1-pro-preview");
    const classes = cell.className.split(/\s+/);

    expect(classes).toContain("truncate");
    // A nowrap cell that is not stretched has to be capped at its track, or it
    // sizes to its content and overflows. Either spelling of the cap will do.
    expect(classes.some((c) => c === "max-w-full" || c === "w-full")).toBe(true);
  });
});
