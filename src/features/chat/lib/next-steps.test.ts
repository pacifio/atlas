import { describe, expect, it } from "vitest";
import { appendNextStepsDirective } from "./next-steps";

describe("appendNextStepsDirective", () => {
  it.each([
    "/mcp",
    "/mcp reconnect all",
    "/mcp enable atlas_memory",
    "/mcp disable atlas_memory",
    "/usage",
    "/status",
    "/review",
    "/remember",
    "/mcp:server:command argument",
    "  /mcp\n",
  ])("preserves the slash command %j without hidden arguments", (command) => {
    expect(appendNextStepsDirective(command)).toBe(command);
  });

  it("still requests suggestions for ordinary messages mentioning a command", () => {
    const prompt = "Explain what /mcp does";
    const wire = appendNextStepsDirective(prompt);
    expect(wire).toContain(`${prompt}\n\n═══ Atlas next-steps ═══`);
    expect(wire).toContain("<next_steps>");
  });
});
