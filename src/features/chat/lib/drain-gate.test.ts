import { describe, expect, it } from "vitest";
import { drainEdge } from "./drain-gate";

const base = {
  prevStatus: "running" as string | null,
  curStatus: "idle",
  prevAcp: "acp-1" as string | undefined,
  curAcp: "acp-1" as string | undefined,
  prevResuming: false,
  curResuming: false,
  prevGrantHold: false,
  curGrantHold: false,
};

describe("drainEdge", () => {
  it("drains the queue when a turn ends on a bound session", () => {
    const edge = drainEdge(base);
    expect(edge.turnFinished).toBe(true);
    expect(edge.drainQueue).toBe(true);
  });

  it("does NOT drain when a bind failure drops a starting tab back to idle", () => {
    // The 2026-09-14 loop: `pendingSend` held the first message with the
    // status `running` and no session; the failure branch re-queued it and
    // set `idle`. That edge must not shift the queue back into `handleSend`.
    const edge = drainEdge({ ...base, prevAcp: undefined, curAcp: undefined });
    expect(edge.turnFinished).toBe(false);
    expect(edge.justBound).toBe(false);
    expect(edge.drainQueue).toBe(false);
  });

  it("drains on the bind landing, even while the status reads running", () => {
    const edge = drainEdge({
      ...base,
      prevStatus: "running",
      curStatus: "running",
      prevAcp: undefined,
      curAcp: "acp-2",
    });
    expect(edge.justBound).toBe(true);
    expect(edge.drainQueue).toBe(true);
  });

  it("drains on the resume flag's falling edge only with a session", () => {
    expect(
      drainEdge({ ...base, prevStatus: "idle", prevResuming: true, curResuming: false })
        .justResumed,
    ).toBe(true);
    expect(
      drainEdge({
        ...base,
        prevStatus: "idle",
        prevResuming: true,
        curResuming: false,
        curAcp: undefined,
      }).justResumed,
    ).toBe(false);
  });

  it("stays quiet on a status edge that is not a turn end", () => {
    expect(drainEdge({ ...base, prevStatus: "idle", curStatus: "running" }).drainQueue).toBe(false);
    expect(drainEdge({ ...base, prevStatus: null, curStatus: "idle" }).drainQueue).toBe(false);
  });

  it("releases nothing while the send gate is closed, then everything on its fall", () => {
    // A bind or a turn's end during a resume, or while a mode the resume could
    // not restore is unanswered, must not send under the agent's own mode.
    const held = { ...base, prevResuming: true, curResuming: true };
    expect(drainEdge({ ...held, prevAcp: undefined }).drainQueue).toBe(false);
    expect(drainEdge({ ...held, prevAcp: undefined }).justBound).toBe(false);
    expect(drainEdge(held).turnFinished).toBe(false);
    expect(drainEdge({ ...base, prevStatus: "idle", prevResuming: true }).justResumed).toBe(true);
  });

  it("holds the queue while the session is live elsewhere, and drains when the hold lifts", () => {
    // A turn ending on a session another process is writing must not shift
    // the next queued message out — that send would fork the transcript.
    const held = drainEdge({ ...base, prevHeldElsewhere: true, curHeldElsewhere: true });
    expect(held.turnFinished).toBe(false);
    expect(held.drainQueue).toBe(false);
    // "Send anyway" (or the other process going quiet) is the release.
    const lifted = drainEdge({
      ...base,
      prevStatus: "idle",
      prevHeldElsewhere: true,
      curHeldElsewhere: false,
    });
    expect(lifted.justResumed).toBe(true);
    expect(lifted.drainQueue).toBe(true);
    // A resume that lands on a live session stays closed.
    expect(
      drainEdge({
        ...base,
        prevStatus: "idle",
        prevResuming: true,
        curResuming: false,
        curHeldElsewhere: true,
        prevHeldElsewhere: true,
      }).drainQueue,
    ).toBe(false);
  });

  describe("the no-AI-grant hold", () => {
    const held = { ...base, prevGrantHold: true, curGrantHold: true };

    it("keeps a message queued during the deferred turn from draining at its end", () => {
      // The answer turned to no mid-turn; the lock waited for the turn, and
      // the user queued a follow-up meanwhile. The turn ending must not send
      // it into a gateway that refuses it.
      const edge = drainEdge({ ...held, prevGrantHold: false });
      expect(edge.turnFinished).toBe(true);
      expect(edge.drainQueue).toBe(false);
      expect(drainEdge(held).drainQueue).toBe(false);
    });

    it("releases the queue when the hold lifts on an idle, bound session", () => {
      const edge = drainEdge({ ...held, prevStatus: "idle", curGrantHold: false });
      expect(edge.grantReleased).toBe(true);
      expect(edge.drainQueue).toBe(true);
    });

    it("does not release into a turn still running or an unbound tab", () => {
      expect(
        drainEdge({ ...held, prevStatus: "running", curStatus: "running", curGrantHold: false })
          .drainQueue,
      ).toBe(false);
      expect(
        drainEdge({ ...held, prevStatus: "idle", curGrantHold: false, curAcp: undefined })
          .drainQueue,
      ).toBe(false);
    });

    it("leaves an agent switch to its own bind", () => {
      // Switching off the native agent lifts the hold in the same commit the
      // session changes; the new bind's `justBound` is the drain, not this.
      const switching = drainEdge({
        ...held,
        prevStatus: "idle",
        curGrantHold: false,
        prevAcp: "acp-1",
        curAcp: undefined,
      });
      expect(switching.grantReleased).toBe(false);
      expect(switching.drainQueue).toBe(false);
      const bound = drainEdge({ ...base, prevStatus: "idle", prevAcp: undefined, curAcp: "acp-2" });
      expect(bound.justBound).toBe(true);
      expect(bound.drainQueue).toBe(true);
    });

    it("holds a fresh bind on the native agent too", () => {
      const edge = drainEdge({ ...held, prevStatus: "idle", prevAcp: undefined, curAcp: "acp-2" });
      expect(edge.justBound).toBe(true);
      expect(edge.drainQueue).toBe(false);
    });
  });
});
