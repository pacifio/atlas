import { describe, expect, it } from "vitest";
import {
  ACTOR_COLOURS,
  actorColour,
  actorFallbackName,
  applyAwareness,
  clampAwareness,
  decodeSpaceAwareness,
  decodeSpaceAwarenessState,
  decodeSpaceFrame,
  decodeSpaceUpdates,
  encodeSpaceAwarenessState,
  encodeSpaceFrame,
  frameAwareness,
  hasNewcomer,
  selectionColours,
  SPACE_FRAME_AWARENESS,
  SPACE_FRAME_UPDATE,
  type SpaceActor,
} from "./space-wire";

// Fixture-byte tests for the interop codec. The server relays these bytes
// without parsing them, so nothing at runtime checks that this codec and the
// web client's agree — these tests are that check, against hand-built frames
// matching `packages/contracts/src/space.ts`.

const utf8 = (s: string) => new TextEncoder().encode(s);

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

describe("frame codec", () => {
  it("round-trips [type][slot][payload]", () => {
    const frame = encodeSpaceFrame(SPACE_FRAME_UPDATE, 3, Uint8Array.of(9, 8, 7));
    expect([...frame]).toEqual([0x01, 3, 9, 8, 7]);
    const decoded = decodeSpaceFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(SPACE_FRAME_UPDATE);
    expect(decoded!.slot).toBe(3);
    expect([...decoded!.payload]).toEqual([9, 8, 7]);
  });

  it("refuses a header-only frame — an empty payload is a client bug", () => {
    expect(decodeSpaceFrame(Uint8Array.of(0x01, 0))).toBeNull();
    expect(decodeSpaceFrame(Uint8Array.of(0x01))).toBeNull();
    expect(decodeSpaceFrame(new Uint8Array(0))).toBeNull();
  });
});

describe("update batches (server → client)", () => {
  it("unpacks u32-BE length-prefixed updates", () => {
    const payload = Uint8Array.from([...u32be(2), 1, 2, ...u32be(3), 3, 4, 5]);
    const updates = decodeSpaceUpdates(payload);
    expect(updates).not.toBeNull();
    expect(updates!.map((u) => [...u])).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it("refuses WHOLESALE when lengths do not add up — never a partial apply", () => {
    // Truncated: claims 5 bytes, carries 2.
    expect(decodeSpaceUpdates(Uint8Array.from([...u32be(5), 1, 2]))).toBeNull();
    // A zero-length update is a lost-sync frame.
    expect(decodeSpaceUpdates(Uint8Array.from(u32be(0)))).toBeNull();
    // A dangling prefix.
    expect(decodeSpaceUpdates(Uint8Array.from([...u32be(1), 7, 0, 0]))).toBeNull();
    // Empty payload decodes to null, not [].
    expect(decodeSpaceUpdates(new Uint8Array(0))).toBeNull();
  });

  it("survives a subarray view (non-zero byteOffset)", () => {
    const padded = Uint8Array.from([0xff, 0xff, ...u32be(1), 42]);
    const updates = decodeSpaceUpdates(padded.subarray(2));
    expect(updates!.map((u) => [...u])).toEqual([[42]]);
  });
});

describe("awareness fanout (server → client)", () => {
  const entry = (actor: string, state: Uint8Array): number[] => [
    utf8(actor).length,
    ...utf8(actor),
    ...u32be(state.length),
    ...state,
  ];

  it("unpacks [u8 actorLen][actor][u32 stateLen][state] entries", () => {
    const state = encodeSpaceAwarenessState({ cursor: { x: 1, y: 2 } });
    const payload = Uint8Array.from([
      ...entry("user_a", state),
      ...entry("user_b", new Uint8Array(0)),
    ]);
    const entries = decodeSpaceAwareness(payload);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(2);
    expect(entries![0].actor).toBe("user_a");
    // Empty state IS valid here: it means user_b departed.
    expect(entries![1].state.length).toBe(0);
  });

  it("refuses a zero-length actor id (lost sync with its own lengths)", () => {
    const payload = Uint8Array.from([0, ...u32be(0)]);
    expect(decodeSpaceAwareness(payload)).toBeNull();
  });

  it("applies departures as REMOVALS, and keeps undecodable actors as-is", () => {
    const a: SpaceActor = {
      id: "user_a",
      name: "A",
      colour: "#fff",
      cursor: { x: 0, y: 0 },
      selection: [],
      viewport: null,
      following: null,
    };
    const before = new Map([["user_a", a]]);
    const departure = Uint8Array.from([utf8("user_a").length, ...utf8("user_a"), ...u32be(0)]);
    const after = applyAwareness(before, departure);
    expect(after.has("user_a")).toBe(false);

    // Undecodable state: the actor is kept, not dropped.
    const junk = utf8("{not json");
    const junkFrame = Uint8Array.from([
      utf8("user_a").length,
      ...utf8("user_a"),
      ...u32be(junk.length),
      ...junk,
    ]);
    const kept = applyAwareness(before, junkFrame);
    expect(kept.get("user_a")).toBe(a);
  });

  it("returns the SAME map when nothing decodes (no wasted re-render)", () => {
    const before = new Map<string, SpaceActor>();
    expect(applyAwareness(before, Uint8Array.of(0))).toBe(before);
  });

  it("detects newcomers but never counts a departure as one", () => {
    const actor = (id: string): SpaceActor => ({
      id,
      name: id,
      colour: "#fff",
      cursor: null,
      selection: [],
      viewport: null,
      following: null,
    });
    const before = new Map([["a", actor("a")]]);
    const withNew = new Map([...before, ["b", actor("b")] as const]);
    expect(hasNewcomer(before, withNew)).toBe(true);
    const withoutA = new Map<string, SpaceActor>();
    expect(hasNewcomer(before, withoutA)).toBe(false);
  });
});

describe("awareness state", () => {
  it("round-trips as UTF-8 JSON and parses rather than casts", () => {
    const state = { name: "Ada", cursor: { x: 4.5, y: -2 }, following: null };
    const decoded = decodeSpaceAwarenessState(encodeSpaceAwarenessState(state));
    expect(decoded).toMatchObject(state);
    // NaN-carrying viewports must not reach xyflow.
    const bad = utf8(JSON.stringify({ viewport: { x: "nope", y: 1, zoom: 1 } }));
    expect(decodeSpaceAwarenessState(bad)!.viewport).toBeUndefined();
    expect(decodeSpaceAwarenessState(new Uint8Array(0))).toBeNull();
  });

  it("clamps name to 64 and selection to 64 — the server does NOT", () => {
    const clamped = clampAwareness({
      name: "x".repeat(100),
      selection: Array.from({ length: 100 }, (_, i) => String(i)),
    });
    expect(clamped.name!.length).toBe(64);
    expect(clamped.selection!.length).toBe(64);
  });

  it("frames own state as [0x02][slot][json]", () => {
    const frame = frameAwareness(7, { cursor: null });
    expect(frame[0]).toBe(SPACE_FRAME_AWARENESS);
    expect(frame[1]).toBe(7);
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(2)))).toEqual({ cursor: null });
  });
});

describe("actor identity — byte-for-byte web parity", () => {
  it("uses the exact 8-colour list in the exact order", () => {
    expect(ACTOR_COLOURS).toEqual([
      "#e11d48",
      "#ea580c",
      "#ca8a04",
      "#16a34a",
      "#0891b2",
      "#2563eb",
      "#7c3aed",
      "#db2777",
    ]);
  });

  it("FNV-1a bucketing matches the reference implementation", () => {
    // Reference: apps/web/src/lib/space-awareness.ts `actorColour` —
    // hash = 0x811c9dc5; hash ^= charCode; hash = imul(hash, 0x01000193)>>>0.
    const reference = (id: string) => {
      let hash = 0x811c9dc5;
      for (let at = 0; at < id.length; at += 1) {
        hash ^= id.charCodeAt(at);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return ACTOR_COLOURS[hash % ACTOR_COLOURS.length];
    };
    for (const id of ["user_01HZX4", "a", "", "better-auth-id-123", "ULID01J8ZQ"]) {
      expect(actorColour(id)).toBe(reference(id));
    }
    // Same person, same colour, forever — a divergence renders one person in
    // two colours across clients.
    expect(actorColour("user_01HZX4")).toBe(actorColour("user_01HZX4"));
  });

  it("falls back to the last underscore segment, truncated at 8", () => {
    expect(actorFallbackName("user_abcdefghij")).toBe("abcdefgh…");
    expect(actorFallbackName("short")).toBe("short");
  });
});

describe("selection outlines", () => {
  it("first claimant wins", () => {
    const actor = (id: string, colour: string, selection: string[]): SpaceActor => ({
      id,
      name: id,
      colour,
      cursor: null,
      selection,
      viewport: null,
      following: null,
    });
    const actors = new Map([
      ["a", actor("a", "#111", ["n1", "n2"])],
      ["b", actor("b", "#222", ["n2", "n3"])],
    ]);
    const colours = selectionColours(actors);
    expect(colours.get("n1")).toBe("#111");
    expect(colours.get("n2")).toBe("#111"); // a claimed it first
    expect(colours.get("n3")).toBe("#222");
  });
});
