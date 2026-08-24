import { describe, expect, it } from "vitest";
import { defaultAgentForNewSession } from "./default-agent";

describe("the agent a new chat starts on", () => {
  it("is the native agent, always", () => {
    // ADR-0002: Atlas ships no ACP agents. Starting a fresh chat on Claude
    // Code named an agent a fresh install does not have — and the agent
    // switcher lives inside the composer that agent's absence disables, so
    // the user could not switch away from it either.
    expect(defaultAgentForNewSession()).toBe("cersei");
  });
});
