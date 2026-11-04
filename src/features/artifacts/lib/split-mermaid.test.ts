import { describe, expect, it } from "vitest";

import { splitMermaid } from "./split-mermaid";

describe("splitMermaid", () => {
  it("keeps plain text as one part", () => {
    expect(splitMermaid("Just prose.")).toEqual([{ kind: "text", body: "Just prose." }]);
  });

  it("splits one closed fence out of the prose around it", () => {
    const parts = splitMermaid("Before.\n```mermaid\nflowchart TD\n  A --> B\n```\nAfter.");
    expect(parts).toEqual([
      { kind: "text", body: "Before.\n" },
      { kind: "mermaid", body: "flowchart TD\n  A --> B" },
      { kind: "text", body: "\nAfter." },
    ]);
  });

  it("splits two fences and drops the whitespace between them", () => {
    const parts = splitMermaid("```mermaid\ngraph LR\n```\n\n```mermaid\nsequenceDiagram\n```");
    expect(parts).toEqual([
      { kind: "mermaid", body: "graph LR" },
      { kind: "mermaid", body: "sequenceDiagram" },
    ]);
  });

  it("leaves an unterminated fence as text, as a streaming answer has it", () => {
    const content = "Here:\n```mermaid\nflowchart TD\n  A -->";
    expect(splitMermaid(content)).toEqual([{ kind: "text", body: content }]);
  });
});
