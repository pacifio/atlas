import { describe, expect, it } from "vitest";
import { NATIVE_AGENT_ID, PLUGIN_ID_BY_AGENT, pluginIdForAgent } from "./agent";

describe("pluginIdForAgent", () => {
  it("routes a session with no agent type to the native agent", () => {
    // The last hardcoded default plugin id. It returned "claude-code-ts",
    // which on a fresh profile routes to an agent that is not installed —
    // reached from resuming a history row that recorded no agent type.
    // ADR-0002: the native agent is the only one always there.
    expect(pluginIdForAgent(undefined)).toBe(PLUGIN_ID_BY_AGENT[NATIVE_AGENT_ID]);
  });

  it("routes the retired `custom` value the same way", () => {
    // Same thing under an older name, and `switchableAgentOf` already resolves
    // it to the native agent — the two must not disagree about one session.
    expect(pluginIdForAgent("custom")).toBe(PLUGIN_ID_BY_AGENT[NATIVE_AGENT_ID]);
  });

  it("maps a first-party agent type to its spec id", () => {
    expect(pluginIdForAgent("claude-code")).toBe("claude-code-ts");
    expect(pluginIdForAgent("codex")).toBe("codex");
  });

  it("passes an external agent's id through — its type IS its plugin id", () => {
    expect(pluginIdForAgent("amp-acp")).toBe("amp-acp");
  });
});
