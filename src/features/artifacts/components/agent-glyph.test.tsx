// @vitest-environment happy-dom
//
// Which mark an agent id draws. The substring ladder (`claude`, `codex`,
// `opencode`, `cursor`, `kilo`, `atlas-agent`) still runs first, so an id that
// merely contains a first-party name gets that mark; resolving only through
// `agentMeta().firstPartyIcon` is a proposed behaviour change awaiting review.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { AgentMetaContext } from "@/features/agents/lib/agent-meta-context";
import { EMPTY_AGENT_REGISTRY, resolveAgentMeta } from "@/features/agents/lib/agent-identity";
import { AgentGlyph } from "./agent-glyph";

beforeEach(cleanup);

const titleOf = (container: HTMLElement) => container.querySelector("svg title")?.textContent;

describe("AgentGlyph", () => {
  it.each(["claude-code", "claude-acp", "claude-code-ts"])("%s draws the Claude mark", (id) => {
    const { container } = render(<AgentGlyph agent={id} />);
    expect(titleOf(container)).toBe("Claude Code");
  });

  it.each([
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
    ["cursor", "Cursor"],
    ["kilo", "Kilo"],
  ])("%s draws its own mark", (id, title) => {
    const { container } = render(<AgentGlyph agent={id} />);
    expect(titleOf(container)).toBe(title);
  });

  it("draws the Atlas mark for the native agent", () => {
    const { container } = render(<AgentGlyph agent="atlas-agent" />);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Atlas");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("tints a first-party mark with its brand hue, and mono drops it", () => {
    const tinted = render(<AgentGlyph agent="codex" />).container.querySelector("svg");
    expect(tinted?.style.color).not.toBe("");
    cleanup();
    const mono = render(<AgentGlyph agent="codex" mono />).container.querySelector("svg");
    expect(mono?.style.color).toBe("");
  });

  it("sizes the mark in pixels", () => {
    const svg = render(<AgentGlyph agent="cursor" size={16} />).container.querySelector("svg");
    expect(svg?.style.width).toBe("16px");
    expect(svg?.style.height).toBe("16px");
  });

  it("draws an external agent's registry icon as a mask", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor"/>';
    const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
    const resolve = (id: string | null | undefined) => ({
      ...resolveAgentMeta(id, EMPTY_AGENT_REGISTRY),
      iconDataUrl: dataUrl,
    });
    const { container } = render(
      <AgentMetaContext.Provider value={resolve}>
        <AgentGlyph agent="gemini-cli" />
      </AgentMetaContext.Provider>,
    );
    const span = container.querySelector("span[aria-hidden]") as HTMLElement | null;
    expect(span?.classList.contains("bg-current")).toBe(true);
    expect(span?.style.getPropertyValue("mask")).toContain(dataUrl);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("falls back to a monogram for an external agent with no icon", () => {
    const { container } = render(<AgentGlyph agent="gemini-cli" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("G");
  });
});
