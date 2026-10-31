import { describe, expect, it } from "vitest";
import {
  isValidPinOrderKey,
  pinOrderKeyBetween,
  pinOrderKeyForNewPin,
  planPinnedReorder,
  sortByPinOrder,
  spreadPinOrderKeys,
} from "./pin-order";

describe("pinOrderKeyBetween", () => {
  it("lands strictly between its neighbours", () => {
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      [null, "n"],
      ["n", null],
      ["b", "c"],
      ["az", "b"],
      ["m", "mb"],
      ["zz", null],
      [null, "ab"],
    ];
    for (const [before, after] of cases) {
      const key = pinOrderKeyBetween(before, after);
      expect(key, `${before} .. ${after}`).not.toBeNull();
      expect(isValidPinOrderKey(key!)).toBe(true);
      if (before !== null) expect(key! > before).toBe(true);
      if (after !== null) expect(key! < after).toBe(true);
    }
  });

  it("keeps finding room after many inserts at the same spot", () => {
    let low: string | null = "m";
    const high = "n";
    for (let i = 0; i < 200; i += 1) {
      const key: string = pinOrderKeyBetween(low, high)!;
      expect(key > low! && key < high).toBe(true);
      low = key;
    }
    let top: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const key: string = pinOrderKeyBetween(null, top)!;
      if (top !== null) expect(key < top).toBe(true);
      top = key;
    }
  });

  it("answers null for corrupt or out-of-order keys", () => {
    expect(pinOrderKeyBetween("c", "b")).toBeNull();
    expect(pinOrderKeyBetween("b", "b")).toBeNull();
    expect(pinOrderKeyBetween("B", null)).toBeNull();
    expect(pinOrderKeyBetween(null, "ba")).toBeNull(); // ends in the minimum digit
  });
});

describe("spreadPinOrderKeys", () => {
  it("is ascending, valid and distinct", () => {
    for (const count of [1, 2, 10, 700]) {
      const keys = spreadPinOrderKeys(count);
      expect(keys).toHaveLength(count);
      expect(new Set(keys).size).toBe(count);
      expect([...keys].sort()).toEqual(keys);
      expect(keys.every(isValidPinOrderKey)).toBe(true);
    }
  });
});

describe("pinOrderKeyForNewPin", () => {
  it("puts a new pin at the top", () => {
    expect(pinOrderKeyForNewPin("m") < "m").toBe(true);
    expect(isValidPinOrderKey(pinOrderKeyForNewPin(null))).toBe(true);
    // A corrupt top key still yields a usable key.
    expect(isValidPinOrderKey(pinOrderKeyForNewPin("ba"))).toBe(true);
  });
});

describe("planPinnedReorder", () => {
  it("rewrites only the moved row when its neighbours have keys", () => {
    const keys = new Map([
      ["a", "d"],
      ["b", "h"],
      ["c", "p"],
    ]);
    const plan = planPinnedReorder({ orderedIds: ["a", "c", "b"], keysById: keys, movedId: "c" });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.id).toBe("c");
    expect(plan[0]!.orderKey > "d" && plan[0]!.orderKey < "h").toBe(true);
  });

  it("rewrites the section when a neighbour has no key", () => {
    const keys = new Map<string, string | null>([
      ["a", "d"],
      ["b", null],
      ["c", "p"],
    ]);
    const plan = planPinnedReorder({ orderedIds: ["a", "c", "b"], keysById: keys, movedId: "c" });
    const next = new Map(keys);
    for (const { id, orderKey } of plan) next.set(id, orderKey);
    const order = ["a", "b", "c"].sort((x, y) => (next.get(x)! < next.get(y)! ? -1 : 1));
    expect(order).toEqual(["a", "c", "b"]);
  });
});

describe("sortByPinOrder", () => {
  it("orders keyed pins by key, then unkeyed ones newest first", () => {
    const row = (threadId: string, pinOrder: string | null, pinnedAt: string) => ({
      threadId,
      pinOrder,
      pinnedAt,
    });
    const sorted = sortByPinOrder([
      row("late", null, "2026-10-24T10:00:00Z"),
      row("n", "n", "2026-10-01T00:00:00Z"),
      row("g", "g", "2026-10-02T00:00:00Z"),
      row("early", null, "2026-10-20T10:00:00Z"),
    ]);
    expect(sorted.map((r) => r.threadId)).toEqual(["g", "n", "late", "early"]);
  });
});
