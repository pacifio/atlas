import { describe, expect, it, vi, beforeEach } from "vitest";

/** Captures the handlers `agent-acquire.ts` registers so tests can drive the
 *  backend's events without a Tauri runtime. */
const handlers = new Map<string, (e: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  },
}));

const { acquirePercent, __testing } = await import("./agent-acquire");

function emitProgress(agentId: string, received: number, total: number | null) {
  handlers.get("atlas:agent-acquire:progress")?.({
    payload: { agentId, received, total },
  });
}
function emitDone(agentId: string, ready: boolean) {
  handlers.get("atlas:agent-acquire:done")?.({ payload: { agentId, ready } });
}

describe("acquirePercent", () => {
  it("renders whole percents from the byte counts", () => {
    expect(acquirePercent({ agentId: "cursor", received: 0, total: 200 })).toBe(0);
    expect(acquirePercent({ agentId: "cursor", received: 50, total: 200 })).toBe(25);
    expect(acquirePercent({ agentId: "cursor", received: 200, total: 200 })).toBe(100);
  });

  it("is null without a content-length, so the pill stays indeterminate", () => {
    expect(acquirePercent(null)).toBeNull();
    expect(acquirePercent({ agentId: "cursor", received: 10, total: null })).toBeNull();
  });

  it("never exceeds 100 if the server under-reports the total", () => {
    expect(acquirePercent({ agentId: "cursor", received: 300, total: 200 })).toBe(100);
  });
});

describe("acquire progress tracking", () => {
  beforeEach(() => {
    __testing.reset();
    __testing.subscribe(() => {});
  });

  it("tracks progress per agent and clears it on done", () => {
    emitProgress("cursor", 40, 100);
    expect(__testing.get("cursor")).toEqual({ agentId: "cursor", received: 40, total: 100 });
    // A second agent downloading concurrently must not clobber the first.
    emitProgress("kilo", 10, 100);
    expect(__testing.get("cursor")?.received).toBe(40);
    expect(__testing.get("kilo")?.received).toBe(10);

    emitDone("cursor", true);
    expect(__testing.get("cursor")).toBeNull();
    expect(__testing.get("kilo")?.received).toBe(10);
  });

  it("clears the pill even when acquisition FAILED", () => {
    // ready:false means we fell back to the PATH command — the download is
    // over either way, so a stuck "Setting up…" pill would be a lie.
    emitProgress("opencode", 90, 100);
    emitDone("opencode", false);
    expect(__testing.get("opencode")).toBeNull();
  });

  it("reports nothing for agents that are not being acquired", () => {
    expect(__testing.get("claude-code-ts")).toBeNull();
  });

  it("notifies subscribers so the composer re-renders", () => {
    const seen: number[] = [];
    __testing.subscribe(() => seen.push(1));
    emitProgress("cursor", 1, 100);
    emitProgress("cursor", 2, 100);
    emitDone("cursor", true);
    expect(seen.length).toBe(3);
  });
});
