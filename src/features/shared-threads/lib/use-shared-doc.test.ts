import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("./shared-threads-api", () => ({}));

import { batchUpdates, fromBase64, toBase64 } from "./use-shared-doc";

describe("the Atlas editor's keystroke batching (ATL-407)", () => {
  it("sends one merged update per window, and never what came from the thread", async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const sent: Uint8Array[] = [];
    const stop = batchUpdates(doc, (u) => sent.push(u), 50);

    text.insert(0, "a");
    text.insert(1, "b");
    text.insert(2, "c");
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);

    // What the thread sent is applied, not echoed.
    const other = new Y.Doc();
    other.getText("content").insert(0, "zz");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), "shared-thread");
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);

    // The batch, applied elsewhere, is the three keystrokes.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, sent[0]!);
    expect(replica.getText("content").toString()).toBe("abc");

    // Stopping sends what is pending.
    text.insert(0, "!");
    stop();
    expect(sent).toHaveLength(2);
    vi.useRealTimers();
  });

  it("round-trips updates through base64", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
