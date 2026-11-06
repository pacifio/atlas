import { describe, expect, it } from "vitest";
import { callButtonPlan } from "./call-plan";

describe("callButtonPlan", () => {
  it("assumes the catalogue defaults until features answer: voice on, meetings off", () => {
    expect(callButtonPlan(undefined)).toEqual({
      phone: { kind: "voice", guestMeeting: false },
      video: false,
    });
  });

  it("a plan without meetings still gets a free voice call, and no video", () => {
    expect(callButtonPlan({ "calls.mesh": true, "calls.paid": false })).toEqual({
      phone: { kind: "voice", guestMeeting: false },
      video: false,
    });
  });

  it("a plan with both offers voice first, a guest meeting second, and video", () => {
    expect(callButtonPlan({ "calls.mesh": true, "calls.paid": true })).toEqual({
      phone: { kind: "voice", guestMeeting: true },
      video: true,
    });
  });

  it("meetings without voice calls fall back to the audio meeting menu", () => {
    expect(callButtonPlan({ "calls.mesh": false, "calls.paid": true })).toEqual({
      phone: { kind: "meeting" },
      video: true,
    });
  });

  it("neither leaves nothing to start", () => {
    expect(callButtonPlan({ "calls.mesh": false, "calls.paid": false })).toEqual({
      phone: null,
      video: false,
    });
  });
});
