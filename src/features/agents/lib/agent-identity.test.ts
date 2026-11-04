// `resolveAgentMeta` is identity as a pure function of a registry snapshot: no
// store, no mock. These pin the answers `agentMeta` gave before the split.

import { describe, expect, it } from "vitest";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import {
  EMPTY_AGENT_REGISTRY,
  resolveAgentMeta,
  type AgentRegistrySnapshot,
} from "./agent-identity";

/** A catalog entry with only the fields identity reads; the rest are irrelevant here. */
function catalogEntry(e: Partial<AgentCatalogEntry> & Pick<AgentCatalogEntry, "id">) {
  return {
    agentType: e.id,
    name: e.id,
    displayName: null,
    iconDataUrl: null,
    source: "installed",
    ...e,
  } as AgentCatalogEntry;
}

function snapshot(
  entries: AgentCatalogEntry[],
  registryEntries: AgentRegistrySnapshot["registryEntries"] = [],
): AgentRegistrySnapshot {
  return {
    catalogById: Object.fromEntries(
      entries.flatMap((e) => [
        [e.id, e],
        [e.agentType, e],
      ]),
    ),
    registryEntries,
  };
}

describe("resolveAgentMeta", () => {
  it("gives a first-party agent its static label and brand icon", () => {
    const m = resolveAgentMeta("codex", EMPTY_AGENT_REGISTRY);
    expect(m).toMatchObject({
      pluginId: "codex",
      agentType: "codex",
      label: "Codex",
      firstPartyIcon: "codex",
      iconDataUrl: null,
      external: false,
    });
  });

  it("treats the registry's claude-acp as Claude Code", () => {
    const m = resolveAgentMeta("claude-acp", EMPTY_AGENT_REGISTRY);
    expect(m.agentType).toBe("claude-code");
    expect(m.firstPartyIcon).toBe("claude-code");
    expect(m.label).toBe("Claude Code");
  });

  it("treats the registry's codex-acp as Codex, as claude-acp is Claude Code", () => {
    const m = resolveAgentMeta("codex-acp", EMPTY_AGENT_REGISTRY);
    expect(m.agentType).toBe("codex");
    expect(m.firstPartyIcon).toBe("codex");
    expect(m.label).toBe("Codex");
    expect(m.external).toBe(false);
  });

  it("does not lend the Claude mark to a third-party claude-* agent", () => {
    const m = resolveAgentMeta("claude-foo", EMPTY_AGENT_REGISTRY);
    expect(m.firstPartyIcon).toBeNull();
    expect(m.external).toBe(true);
  });

  it("names and draws an external agent from its catalog entry", () => {
    const reg = snapshot([
      catalogEntry({
        id: "gemini",
        name: "Gemini CLI",
        iconDataUrl: "data:image/svg+xml;base64,AA",
      }),
    ]);
    const m = resolveAgentMeta("gemini", reg);
    expect(m.label).toBe("Gemini CLI");
    expect(m.iconDataUrl).toBe("data:image/svg+xml;base64,AA");
    expect(m.source).toBe("installed");
    expect(m.availability).toBe("ready");
  });

  it("prefers the user's display name over the catalog name", () => {
    const reg = snapshot([catalogEntry({ id: "gemini", name: "Gemini CLI", displayName: "G" })]);
    expect(resolveAgentMeta("gemini", reg).label).toBe("G");
  });

  it("falls back to the registry listing for an agent the catalog no longer has", () => {
    const reg = snapshot([], [{ id: "goose", name: "Goose", iconDataUrl: "data:x" }]);
    const m = resolveAgentMeta("goose", reg);
    expect(m.label).toBe("Goose");
    expect(m.iconDataUrl).toBe("data:x");
  });

  it("prettifies an id nothing knows", () => {
    expect(resolveAgentMeta("some-agent_acp", EMPTY_AGENT_REGISTRY).label).toBe("Some Agent Acp");
  });

  it("resolves a missing id to the native agent", () => {
    for (const id of [null, undefined, ""]) {
      const m = resolveAgentMeta(id, EMPTY_AGENT_REGISTRY);
      expect(m.agentType).toBe("atlas-agent");
      expect(m.label).toBe("Atlas Agent");
    }
  });

  it("reports no source or availability before the catalog hydrates", () => {
    for (const id of ["codex", "gemini"]) {
      const m = resolveAgentMeta(id, EMPTY_AGENT_REGISTRY);
      expect(m.source).toBeNull();
      expect(m.availability).toBeNull();
    }
  });
});
