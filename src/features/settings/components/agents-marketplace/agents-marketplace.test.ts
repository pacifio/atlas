import { describe, expect, it, vi } from "vitest";

// The component module pulls in Tauri IPC + zustand at import time; none of
// that is needed for the pure card-state precedence under test.
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}));

const { cardState, installKind, marketplaceCards } = await import("./agents-marketplace");

type Entry = import("@/features/agents/lib/agent-registry-api").AcpRegistryEntry;
type Catalog = import("@/types/agent-catalog").AgentCatalogEntry;

function listed(e: Partial<Entry> = {}): Entry {
  return {
    id: "amp-acp",
    name: "Amp",
    version: "1.0.0",
    description: null,
    repository: null,
    website: null,
    iconDataUrl: null,
    installed: false,
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
    ...e,
  } as Entry;
}

function catalog(source: Catalog["source"], installed = false): Catalog {
  return { source, installed } as Catalog;
}

describe("cardState", () => {
  it("has no built-in state — Atlas ships no first-party external agents", () => {
    // ADR-0002: the only ways an agent exists are "the user installed
    // it" and "it is on their PATH". A card can never say "ships with Atlas".
    const states = [
      cardState(listed(), undefined),
      cardState(listed({ installed: true }), undefined),
      cardState(listed(), catalog("detected")),
    ];
    expect(states).toEqual(["install", "installed", "detected"]);
  });

  it("ignores a stale `builtin` flag from an older backend", () => {
    // The field is gone from the wire, but a running app can still be holding
    // a listing fetched before an update. It must not resurrect the state.
    const stale = { ...listed(), builtin: true } as Entry;
    expect(cardState(stale, undefined)).toBe("install");
    expect(cardState({ ...stale, installed: true } as Entry, undefined)).toBe("installed");
  });

  it("reports an Atlas-installed agent as installed even when also on PATH", () => {
    // Both can be true; "installed" is the one with a Remove action behind it.
    expect(cardState(listed({ installed: true }), catalog("detected", true))).toBe("installed");
  });

  it("reports a PATH-only agent as detected, not installable", () => {
    // The system-first case: Atlas found it, but never installed it, so
    // neither Install nor Remove is the honest primary action.
    expect(cardState(listed(), catalog("detected"))).toBe("detected");
  });

  it("offers Install for everything else", () => {
    // The catalog only carries the native agent, installs and detections, so a
    // plain not-installed registry entry has NO catalog entry at all.
    expect(cardState(listed(), undefined)).toBe("install");
    expect(cardState(listed(), catalog("npx"))).toBe("install");
    expect(cardState(listed(), catalog("unavailable"))).toBe("install");
  });

  it("falls back to the listing alone before the catalog hydrates", () => {
    expect(cardState(listed({ installed: true }), undefined)).toBe("installed");
    expect(cardState(listed(), undefined)).toBe("install");
  });
});

describe("installKind", () => {
  it("accepts a detection instead of downloading over it", () => {
    // The point of a "Detected on your system" card: the user already has the
    // binary, so installing means pointing the installed map at THEIR copy
    // (a `custom` entry), not fetching Atlas's own.
    expect(installKind("detected")).toBe("detected");
  });

  it("downloads for a plain registry offer", () => {
    expect(installKind("install")).toBe("registry");
  });
});

describe("marketplaceCards", () => {
  /** A catalog index, keyed the way the store keys it: by id AND agentType. */
  function index(entries: Array<Partial<Catalog> & { id: string }>): Record<string, Catalog> {
    const out: Record<string, Catalog> = {};
    for (const e of entries) {
      const full = { agentType: e.id, name: e.id, kind: "external", ...e } as Catalog;
      out[full.id] = full;
      out[full.agentType] = full;
    }
    return out;
  }

  it("synthesizes a card for an agent the registry doesn't list", () => {
    const cards = marketplaceCards([], index([{ id: "home-grown", source: "detected" }]));
    expect(cards.map((c) => c.id)).toEqual(["home-grown"]);
  });

  it("keeps an off-registry agent listed after the user installs it", () => {
    // Regression: the synthetic cards were built from detections only, so
    // accepting one made its card vanish — and with it the only Remove button
    // the user had for an agent the registry has never heard of.
    const cards = marketplaceCards(
      [],
      index([{ id: "home-grown", source: "installed", installed: true }]),
    );
    expect(cards.map((c) => c.id)).toEqual(["home-grown"]);
    expect(cardState(cards[0], undefined)).toBe("installed");
  });

  it("never renders an agent twice, however the catalog is keyed", () => {
    // catalogById holds every entry under both its id and its agentType, and
    // the registry may list it as well.
    const catalogById = index([
      { id: "claude-code-ts", agentType: "claude-code", source: "installed", installed: true },
    ]);
    expect(marketplaceCards([], catalogById)).toHaveLength(1);
    const asListed = [listed({ id: "claude-code-ts" })];
    expect(marketplaceCards(asListed, catalogById).map((c) => c.id)).toEqual(["claude-code-ts"]);
  });

  it("leaves the native agent out — it is not a marketplace agent", () => {
    // Cersei is in-process. There is nothing to install and nothing to remove.
    const cards = marketplaceCards(
      [],
      index([{ id: "cersei", kind: "native", source: "in-process" }]),
    );
    expect(cards).toEqual([]);
  });
});
