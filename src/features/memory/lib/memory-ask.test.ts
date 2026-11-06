// What Memory hands the agent: the chips and prompts behind the prompt line,
// a memory's "Ask agent…", Review's "Ask agent…" and Activity's "Why did you
// learn this?".
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "./shared-memory-api";
import type { ActivityGroup, ActivityLine } from "./memory-activity";
import {
  DIGEST_ENTRIES,
  activityAsk,
  entryContext,
  memoryDigest,
  projectLabel,
  reviewAsk,
} from "./memory-ask";

function entry(id: number, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: "fact",
    key: "",
    content: `entry ${id}`,
    status: "",
    source: "extractor",
    agent: "codex",
    sessionId: "s1",
    confidence: 0.8,
    createdAt: 1,
    updatedAt: id,
    lastUsedAt: null,
    uses: 0,
    revision: 1,
    state: "active",
    ...over,
  } as MemoryEntry;
}

const line: ActivityLine = {
  seq: 7,
  kind: "decision",
  verb: "decided",
  text: "Use Postgres",
  path: null,
  entryId: 3,
};
const group: ActivityGroup = {
  key: "s1:7",
  agent: "claude",
  sessionId: "acp-1",
  end: Date.UTC(2026, 8, 18, 12),
  lines: [line],
};

describe("entryContext", () => {
  it("names the memory, its kind and its project", () => {
    expect(entryContext(entry(3, { kind: "decision" }), "/work/shop/")).toEqual({
      kind: "memory_entry",
      id: "3",
      memoryKind: "decision",
      text: "entry 3",
      project: "shop",
    });
    expect(projectLabel(null)).toBeNull();
  });
});

describe("memoryDigest", () => {
  it("lists current memories, most used first, and leaves archived ones out", () => {
    const digest = memoryDigest(
      [
        entry(1, { uses: 1 }),
        entry(2, { uses: 9, kind: "decision" }),
        entry(3, { state: "archived", uses: 50 }),
        entry(4, { state: "candidate" }),
      ],
      "/work/shop",
    )!;
    const lines = digest.text.split("\n");
    expect(lines[0]).toBe("shop shared memory, all 3 current");
    expect(lines.slice(1)).toEqual([
      "- [decision #2] entry 2",
      "- [fact #1] entry 1",
      "- [fact #4, unconfirmed] entry 4",
    ]);
  });

  it("caps the list and says so", () => {
    const many = Array.from({ length: DIGEST_ENTRIES + 5 }, (_, i) => entry(i + 1));
    const lines = memoryDigest(many, "/work/shop")!.text.split("\n");
    expect(lines).toHaveLength(DIGEST_ENTRIES + 1);
    expect(lines[0]).toBe(`shop shared memory, the ${DIGEST_ENTRIES} most used of 25 current`);
  });

  it("flattens and shortens a long memory to one line", () => {
    const text = memoryDigest([entry(1, { content: `a\n${"b".repeat(400)}` })], null)!.text;
    const row = text.split("\n")[1];
    expect(row.startsWith("- [fact #1] a b")).toBe(true);
    expect(row.endsWith("…")).toBe(true);
  });

  it("is nothing when nothing is remembered", () => {
    expect(memoryDigest([entry(1, { state: "archived" })], "/p")).toBeNull();
  });
});

describe("reviewAsk", () => {
  it("hands every memory an item is about, with a rewrite prompt", () => {
    const conflict = reviewAsk({ type: "conflict", key: "c", a: entry(1), b: entry(2) }, "/p");
    expect(conflict.context.map((c) => (c.kind === "memory_entry" ? c.id : ""))).toEqual([
      "1",
      "2",
    ]);
    expect(conflict.prompt).toMatch(/disagree/);
    const merge = reviewAsk({ type: "merge", key: "m", keep: entry(1), drop: [entry(2)] }, "/p");
    expect(merge.context).toHaveLength(2);
    const candidate = reviewAsk({ type: "candidate", key: "x", entry: entry(5) }, "/p");
    expect(candidate.prompt).toMatch(/before I approve/);
  });
});

describe("activityAsk", () => {
  it("asks the open session that wrote the line, with the line only", () => {
    const ask = activityAsk(line, group, entry(3), "/work/shop", "chat-a", "Claude Code");
    expect(ask.target).toBe("chat-a");
    expect(ask.prompt).toBe("Why did you learn this? ");
    expect(ask.context).toEqual([entryContext(entry(3), "/work/shop")]);
  });

  it("asks a new session otherwise, with where the line came from", () => {
    const ask = activityAsk(line, group, null, "/work/shop", null, "Claude Code");
    expect(ask.target).toBe("new");
    expect(ask.context).toHaveLength(1);
    const provenance = ask.context[0];
    expect(provenance.kind).toBe("quote");
    if (provenance.kind !== "quote") return;
    expect(provenance.text).toContain("Claude Code decided Use Postgres");
    expect(provenance.text).toContain("Session: acp-1");
    expect(provenance.text).toContain("At: 2026-09-18T12:00:00.000Z");
    expect(provenance.text).toContain("Project: shop");
  });

  it("keeps the memory beside the provenance when the line became one", () => {
    const ask = activityAsk(line, group, entry(3), "/work/shop", null, "Claude Code");
    expect(ask.context.map((c) => c.kind)).toEqual(["memory_entry", "quote"]);
  });
});
