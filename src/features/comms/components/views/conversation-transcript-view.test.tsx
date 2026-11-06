// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConversationTranscriptView, type TranscriptItem } from "./conversation-transcript-view";

/**
 * The transcript mounts a window of the newest items rather than the whole
 * history, draws the "New messages" rule where the container says unread
 * starts, and keeps the typing hint in a live region.
 */
type Item = TranscriptItem & { kind: "group" };

function items(n: number, unreadAt = -1): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "group",
    key: `g${i}`,
    newDay: false,
    dayAt: 0,
    unreadBefore: i === unreadAt,
  }));
}

function show(list: Item[], typingLabel: string | null = null) {
  return render(
    <ConversationTranscriptView
      items={list}
      renderItem={(item) => <p>{item.key}</p>}
      containsMessage={() => false}
      status="ready"
      onRetry={() => {}}
      intro={null}
      typingLabel={typingLabel}
      messageCount={list.length}
      hasOlder={false}
      onLoadOlder={async () => false}
      dropActive={false}
      convKey="c1"
      composer={null}
    />,
  );
}

afterEach(cleanup);

describe("ConversationTranscriptView", () => {
  it("mounts everything when the history is short", () => {
    const { container } = show(items(30));
    expect(container.querySelectorAll("[data-item-key]")).toHaveLength(30);
  });

  it("mounts only the newest 80 items of a long history", () => {
    const { container } = show(items(300));
    const mounted = container.querySelectorAll<HTMLElement>("[data-item-key]");
    expect(mounted).toHaveLength(80);
    expect(mounted[0].dataset.itemKey).toBe("g220");
    expect(mounted[79].dataset.itemKey).toBe("g299");
  });

  it("draws the New messages rule above the first unread group", () => {
    show(items(10, 4));
    const rule = screen.getByRole("separator", { name: "New messages" });
    expect(rule.closest("[data-item-key]")?.getAttribute("data-item-key")).toBe("g4");
  });

  it("keeps the typing hint inside a polite live region", () => {
    show(items(3), "Priya is typing");
    const hint = screen.getByText("Priya is typing");
    expect(hint.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
  });
});
