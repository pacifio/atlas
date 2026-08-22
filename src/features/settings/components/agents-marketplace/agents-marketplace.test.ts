import { describe, expect, it, vi } from "vitest";

// The component module pulls in Tauri IPC + zustand at import time; none of
// that is needed for the pure card-state precedence under test.
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}));

const { cardState } = await import("./agents-marketplace");

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
    builtin: false,
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
  it("puts built-in above everything — it is never installable", () => {
    expect(cardState(listed({ builtin: true }), catalog("detected"))).toBe("builtin");
    expect(cardState(listed({ builtin: true, installed: true }), undefined)).toBe("builtin");
  });

  it("reports an Atlas-installed agent as installed even when also on PATH", () => {
    // Both can be true; "installed" is the one with a Remove action behind it.
    expect(cardState(listed({ installed: true }), catalog("detected", true))).toBe("installed");
  });

  it("reports a PATH-only agent as detected, not installable", () => {
    // The system-first case: it already works, but Atlas didn't put it there,
    // so neither Install nor Remove is the honest action.
    expect(cardState(listed(), catalog("detected"))).toBe("detected");
  });

  it("offers Install for everything else", () => {
    expect(cardState(listed(), undefined)).toBe("install");
    expect(cardState(listed(), catalog("npx"))).toBe("install");
    expect(cardState(listed(), catalog("unavailable"))).toBe("install");
  });

  it("falls back to the listing alone before the catalog hydrates", () => {
    expect(cardState(listed({ installed: true }), undefined)).toBe("installed");
    expect(cardState(listed(), undefined)).toBe("install");
  });
});

describe("cardState", () => {
  // `listed()`/typed stubs rather than `as never`: spreading a `never` is an
  // error under the test tsconfig, and the cast hid which fields cardState
  // actually reads.
  const onPath = { source: "detected" } as Catalog;
  it("offers Install for a normal not-installed registry agent", () => {
    // The catalog only lists spawnable agents, so a not-installed registry
    // entry has NO catalog entry — this must still be installable.
    expect(cardState(listed(), undefined)).toBe("install");
  });
  it("prefers builtin, then installed, then detected", () => {
    expect(cardState(listed({ builtin: true }), undefined)).toBe("builtin");
    expect(cardState(listed({ installed: true }), undefined)).toBe("installed");
    expect(cardState(listed(), onPath)).toBe("detected");
    // An installed agent that is ALSO on PATH still offers Remove.
    expect(cardState(listed({ installed: true }), onPath)).toBe("installed");
  });
});
