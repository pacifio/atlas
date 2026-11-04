// @vitest-environment happy-dom
// The agent mark resolves identity from context, not from the registry store:
// without a provider it still draws something identifying (a monogram), and
// with one it draws whatever the provided resolver says. No store is mocked.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { resolveAgentMeta, type AgentMetaResolver } from "@/features/agents/lib/agent-identity";
import { AgentMetaContext } from "@/features/agents/lib/agent-meta-context";
import type { FirstPartyAgent } from "@/types/agent";
import { AgentGlyph, AgentMark, FIRST_PARTY_MARKS } from "./agent-mark";

// `globals: false` in vitest.config.ts — auto-cleanup is not registered.
beforeEach(cleanup);

// No `currentColor`, so the icon is drawn as an `<img>` (see `ExternalAgentMark`).
const ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
)}`;

const withGemini: AgentMetaResolver = (id) =>
  resolveAgentMeta(id, {
    catalogById: {},
    registryEntries: [{ id: "gemini", name: "Gemini CLI", iconDataUrl: ICON }],
  });

describe("AgentMark", () => {
  it("draws a monogram for an external agent when no provider is mounted", () => {
    const { container } = render(<AgentMark agentType="gemini" />);
    expect(container.textContent).toBe("G");
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws the icon the provided resolver names", () => {
    const { container } = render(
      <AgentMetaContext.Provider value={withGemini}>
        <AgentMark agentType="gemini" />
      </AgentMetaContext.Provider>,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(ICON);
    expect(container.textContent).toBe("");
  });

  it("draws the Claude Code mark for Claude Code and its registry alias", () => {
    for (const id of ["claude-code", "claude-acp"]) {
      const { container } = render(<AgentGlyph agentType={id} />);
      expect(container.querySelector("title")?.textContent).toBe("Claude Code");
      cleanup();
    }
  });

  it("does not lend the Claude Code mark to a third-party claude-* agent", () => {
    const { container } = render(<AgentGlyph agentType="claude-foo" />);
    expect(container.querySelector("title")).toBeNull();
  });

  it("draws the registry's Codex adapter from its registry identity, not the Codex mark", () => {
    const { container } = render(<AgentGlyph agentType="codex-acp" />);
    expect(container.querySelector("title")).toBeNull();
  });

  it("draws the Atlas mark as an svg, not the app-icon image", () => {
    const { container } = render(<AgentGlyph agentType="atlas-agent" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("FIRST_PARTY_MARKS", () => {
  it("has exactly one mark per first-party agent", () => {
    const all: Record<FirstPartyAgent, true> = {
      "claude-code": true,
      codex: true,
      opencode: true,
      cursor: true,
      kilo: true,
      "atlas-agent": true,
    };
    expect(Object.keys(FIRST_PARTY_MARKS).sort()).toEqual(Object.keys(all).sort());
  });
});
