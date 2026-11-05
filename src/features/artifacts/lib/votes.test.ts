import { describe, expect, it } from "vitest";
import { nextVote, voteOf, withVote } from "./votes";

describe("votes", () => {
  it("reads one person's side", () => {
    const v = { up: ["a"], down: ["b"] };
    expect(voteOf(v, "a")).toBe(1);
    expect(voteOf(v, "b")).toBe(-1);
    expect(voteOf(v, "c")).toBe(0);
    expect(voteOf(v, null)).toBe(0);
  });

  it("takes your own vote back, and switches the other way", () => {
    expect(nextVote(1, 1)).toBe(0);
    expect(nextVote(1, -1)).toBe(-1);
    expect(nextVote(0, 1)).toBe(1);
    expect(nextVote(-1, -1)).toBe(0);
  });

  it("stores a vote as the server does: one per person, a switch joins the back", () => {
    const v = { up: ["me", "x"], down: ["y"] };
    expect(withVote(v, "me", -1)).toEqual({ up: ["x"], down: ["y", "me"] });
    expect(withVote(v, "me", 0)).toEqual({ up: ["x"], down: ["y"] });
    // Voting the side you are on keeps you there, once.
    expect(withVote({ up: ["me"], down: [] }, "me", 1)).toEqual({ up: ["me"], down: [] });
  });
});
