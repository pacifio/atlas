// The marketed half of the composer's agent picker. Atlas ships no ACP agents
// (ADR-0002), so a fresh profile can switch to exactly one thing — this list is
// what stops that from reading as "Atlas supports one agent".
//
// It is marketing, not capability: nothing here is spawnable, and an id the
// registry stops publishing has to disappear rather than offer an install that
// cannot be performed.

import { describe, expect, it } from "vitest";
import { FEATURED_AGENT_IDS, featuredAgentOffers } from "./featured-agents";

function row(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    iconDataUrl: null,
    installed: false,
    platformSupported: true,
    ...over,
  } as Parameters<typeof featuredAgentOffers>[0][number];
}

const listing = FEATURED_AGENT_IDS.map((id) => row(id));

describe("featuredAgentOffers", () => {
  it("offers the featured agents in their curated order, not the registry's", () => {
    const shuffled = [...listing].reverse();
    expect(featuredAgentOffers(shuffled, new Set()).map((o) => o.id)).toEqual([
      ...FEATURED_AGENT_IDS,
    ]);
  });

  it("drops an agent the moment it is installed", () => {
    // It moves UP into the switchable list above; showing it in both would
    // offer an install for something the user already has.
    const withClaude = listing.map((e) => (e.id === "claude-acp" ? { ...e, installed: true } : e));
    expect(featuredAgentOffers(withClaude, new Set()).map((o) => o.id)).not.toContain("claude-acp");
  });

  it("drops an agent the user already has under either of its ids", () => {
    // The catalog carries a registry id AND an agentType alias; the picker holds
    // both, because which one identifies an installed agent depends on where you
    // looked it up.
    expect(featuredAgentOffers(listing, new Set(["cursor"])).map((o) => o.id)).not.toContain(
      "cursor",
    );
  });

  it("never offers an install the registry cannot perform", () => {
    // An id the listing has never heard of has no install path — a short list
    // beats a broken button.
    expect(featuredAgentOffers([], new Set())).toEqual([]);
    expect(featuredAgentOffers([row("claude-acp")], new Set()).map((o) => o.id)).toEqual([
      "claude-acp",
    ]);
  });

  it("keeps a platform-unsupported agent in the list, flagged", () => {
    // Hidden instead of disabled would make the list silently differ per
    // machine, which reads as a bug rather than a limitation.
    const noBuild = listing.map((e) =>
      e.id === "pi-acp" ? { ...e, platformSupported: false } : e,
    );
    const offer = featuredAgentOffers(noBuild, new Set()).find((o) => o.id === "pi-acp");
    expect(offer).toBeDefined();
    expect(offer!.platformSupported).toBe(false);
  });

  it("carries the registry's own name and icon", () => {
    const offers = featuredAgentOffers(
      [row("codex-acp", { name: "Codex", iconDataUrl: "data:image/svg+xml;base64,AAA" })],
      new Set(),
    );
    expect(offers[0]).toMatchObject({
      id: "codex-acp",
      label: "Codex",
      iconDataUrl: "data:image/svg+xml;base64,AAA",
    });
  });
});
