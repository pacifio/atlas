import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../types";
import {
  defaultScope,
  matchesCheckpoint,
  sessionCheckpoints,
  toggleScope,
} from "./checkpoint-scope-picker";

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: over.id ?? "e",
    kind: "prompt",
    commitSha: null,
    commitSubject: null,
    branch: null,
    ...over,
  } as TimelineEntry;
}

const older = entry({
  id: "c1",
  kind: "checkpoint",
  commitSha: "4f21a90aa",
  commitSubject: "feat(api): move user reads onto /v2",
  branch: "feature/auth-v2",
});
const newer = entry({ id: "c2", kind: "checkpoint", commitSha: "c0ffee1bb", branch: "main" });
const prompt = entry({ id: "p", kind: "prompt" });
const unlinked = entry({ id: "u", kind: "checkpoint", commitSha: null });

describe("sessionCheckpoints", () => {
  it("keeps checkpoints with a sha, newest first", () => {
    expect(sessionCheckpoints([prompt, older, unlinked, newer]).map((e) => e.id)).toEqual([
      "c2",
      "c1",
    ]);
  });
});

describe("defaultScope", () => {
  it("is the whole Session when there are no checkpoints", () => {
    expect(defaultScope([prompt, unlinked])).toBeNull();
  });

  it("is the latest checkpoint otherwise", () => {
    expect(defaultScope([older, prompt, newer])).toEqual(["c0ffee1bb"]);
  });
});

describe("toggleScope", () => {
  it("adds a checkpoint to the whole-Session scope", () => {
    expect(toggleScope(null, "a")).toEqual(["a"]);
  });

  it("adds to and removes from a scope, keeping order", () => {
    expect(toggleScope(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleScope(["a", "b"], "a")).toEqual(["b"]);
  });

  it("deselecting the last checkpoint means the whole Session, not nothing", () => {
    expect(toggleScope(["a"], "a")).toBeNull();
  });
});

describe("matchesCheckpoint", () => {
  it("matches subject, sha and branch, case-insensitively", () => {
    expect(matchesCheckpoint(older, "USER READS")).toBe(true);
    expect(matchesCheckpoint(older, "4f21")).toBe(true);
    expect(matchesCheckpoint(older, "auth-v2")).toBe(true);
  });

  it("matches everything on a blank query", () => {
    expect(matchesCheckpoint(newer, "  ")).toBe(true);
  });

  it("misses when nothing contains the query", () => {
    expect(matchesCheckpoint(older, "billing")).toBe(false);
    // No subject: only sha and branch are searched.
    expect(matchesCheckpoint(newer, "feat")).toBe(false);
  });
});
