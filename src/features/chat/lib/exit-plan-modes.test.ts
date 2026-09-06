import { describe, expect, it } from "vitest";
import {
  exitPlanModeForOption,
  exitPlanOffersBypass,
  exitPlanOptionRestartsSession,
} from "./exit-plan-modes";

// The adapter's plan-approval option ids (permissions/options/shared.js in
// @agentclientprotocol/claude-agent-acp) and the mode each one sets.
describe("exitPlanModeForOption", () => {
  it("maps every adapter option to the mode it applies", () => {
    expect(exitPlanModeForOption("exit-plan-default")).toBe("default");
    expect(exitPlanModeForOption("exit-plan-accept-edits")).toBe("acceptEdits");
    expect(exitPlanModeForOption("exit-plan-auto")).toBe("auto");
    expect(exitPlanModeForOption("exit-plan-bypass")).toBe("bypassPermissions");
    expect(exitPlanModeForOption("exit-plan-clear-auto")).toBe("auto");
    expect(exitPlanModeForOption("exit-plan-clear-bypass")).toBe("bypassPermissions");
    expect(exitPlanModeForOption("exit-plan-clear-accept-edits")).toBe("acceptEdits");
  });

  it("answers null for a rejection or an unknown option", () => {
    expect(exitPlanModeForOption("reject")).toBeNull();
    expect(exitPlanModeForOption("allow-once")).toBeNull();
  });

  it("knows which options restart the session", () => {
    expect(exitPlanOptionRestartsSession("exit-plan-clear-auto")).toBe(true);
    expect(exitPlanOptionRestartsSession("exit-plan-auto")).toBe(false);
  });

  // On an auto-capable model the prompt is default / clear-auto / auto /
  // reject — no bypass at all. That is the Fable 5.1 case.
  it("detects a prompt with no bypass option", () => {
    expect(
      exitPlanOffersBypass([
        "exit-plan-default",
        "exit-plan-clear-auto",
        "exit-plan-auto",
        "reject",
      ]),
    ).toBe(false);
    expect(exitPlanOffersBypass(["exit-plan-default", "exit-plan-bypass", "reject"])).toBe(true);
  });
});
