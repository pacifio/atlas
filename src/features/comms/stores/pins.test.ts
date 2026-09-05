import { describe, expect, it } from "vitest";
import { toggleRail, withPins } from "./comms-store";

// Pin rails are per conversation and each one is COMPLETE. The regression
// these cover: the rail merge used to be a flat union across every
// conversation, so an id the server had dropped was re-added from the local
// copy on every event — pinning worked, unpinning silently came back.

describe("withPins", () => {
  it("REMOVES an id the new rail omits — the unpin regression", () => {
    const seeded = withPins({}, "c1", ["m1", "m2"]);
    expect(seeded.pinned).toEqual(["m1", "m2"]);

    // The server accepted an unpin of m1 and broadcast the shortened rail.
    const after = withPins(seeded.pinnedByConv, "c1", ["m2"]);
    expect(after.pinnedByConv.c1).toEqual(["m2"]);
    expect(after.pinned).toEqual(["m2"]);
    expect(after.pinned).not.toContain("m1");
  });

  it("unpinning the last pin empties the rail rather than keeping it", () => {
    const seeded = withPins({}, "c1", ["m1"]);
    const after = withPins(seeded.pinnedByConv, "c1", []);
    expect(after.pinnedByConv.c1).toEqual([]);
    expect(after.pinned).toEqual([]);
  });

  it("leaves OTHER conversations' rails alone — why rails are keyed at all", () => {
    let state = withPins({}, "c1", ["m1"]).pinnedByConv;
    state = withPins(state, "c2", ["m9"]).pinnedByConv;

    const after = withPins(state, "c1", []);
    expect(after.pinnedByConv.c1).toEqual([]);
    expect(after.pinnedByConv.c2).toEqual(["m9"]);
    // The flat lookup keeps c2's pin: a message row renders its own pin
    // without knowing which conversation it belongs to.
    expect(after.pinned).toEqual(["m9"]);
  });

  it("adds a new pin, and never duplicates one", () => {
    const first = withPins({}, "c1", ["m1"]);
    const second = withPins(first.pinnedByConv, "c1", ["m2", "m1"]);
    expect(second.pinned).toEqual(["m2", "m1"]);
    const again = withPins(second.pinnedByConv, "c1", ["m2", "m1"]);
    expect(again.pinned).toEqual(["m2", "m1"]);
  });

  it("treats a missing rail as empty rather than throwing", () => {
    expect(withPins({}, "c1", undefined).pinned).toEqual([]);
  });

  it("toggleRail: pin prepends, unpin removes, no-ops answer null", () => {
    // Front of the rail — Rust's optimistic block and the server both order
    // newest-first, and three sources disagreeing would make the rail dance.
    expect(toggleRail(["m1"], "m2", true)).toEqual(["m2", "m1"]);
    expect(toggleRail(["m2", "m1"], "m1", false)).toEqual(["m2"]);
    // Already in the asked state: null, so the store performs no write.
    expect(toggleRail(["m1"], "m1", true)).toBeNull();
    expect(toggleRail([], "m1", false)).toBeNull();
  });

  it("the optimistic step and Rust's echo settle to the same state", () => {
    // Renderer: toggle locally, replace the rail.
    const optimistic = withPins({}, "c1", toggleRail([], "m1", true)!);
    // Rust's echo replays the identical rail through `pinsChanged`.
    const echoed = withPins(optimistic.pinnedByConv, "c1", ["m1"]);
    expect(echoed.pinnedByConv).toEqual(optimistic.pinnedByConv);
    expect(echoed.pinned).toEqual(["m1"]);

    // And the unpin round: optimistic removal, then the echo of [].
    const removed = withPins(echoed.pinnedByConv, "c1", toggleRail(["m1"], "m1", false)!);
    const settled = withPins(removed.pinnedByConv, "c1", []);
    expect(settled.pinned).toEqual([]);
  });

  it("does not alias the caller's array into store state", () => {
    const rail = ["m1"];
    const out = withPins({}, "c1", rail);
    rail.push("m2");
    expect(out.pinnedByConv.c1).toEqual(["m1"]);
  });
});
