// The sidebar's band mapping is the resume path's routing table, and a wrong
// entry fails SILENTLY: clicking a history row spawns an id the registry
// doesn't know, `UnknownSpec`, dead click. These tests pin both directions of
// the band ↔ registry-id mapping introduced by the ACP registry-only port.
import { describe, expect, it, vi } from "vitest";

// The component module pulls in the full chat stack; stub the boundaries the
// two pure helpers under test never touch.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { sidebarAgentOf, AGENT_TYPE_BY_SIDEBAR } = await import("./session-sidebar");

describe("sidebarAgentOf (agent id → transcript-store band)", () => {
  it("folds canonical registry ids into the store band their transcripts land in", () => {
    // A live codex-acp session and the ~/.codex disk row it produces MUST be
    // one band, or twin suppression / row icon / delete routing all miss.
    expect(sidebarAgentOf("codex-acp")).toBe("codex");
    expect(sidebarAgentOf("claude-acp")).toBe("claude");
  });

  it("keeps the bands whose registry id already names the store", () => {
    for (const id of ["opencode", "cursor", "kilo", "cersei"]) {
      expect(sidebarAgentOf(id)).toBe(id);
    }
  });

  it("passes an unknown installed agent through as its own band", () => {
    expect(sidebarAgentOf("amp-acp")).toBe("amp-acp");
  });
});

describe("AGENT_TYPE_BY_SIDEBAR (band → spawnable registry id)", () => {
  it("routes every disk band to an id the registry can actually spawn", () => {
    // The regression this pins: claude → "claude-code" / codex → "codex"
    // survived the port and made every Claude/Codex history row a dead click.
    expect(AGENT_TYPE_BY_SIDEBAR.claude).toBe("claude-acp");
    expect(AGENT_TYPE_BY_SIDEBAR.codex).toBe("codex-acp");
    expect(AGENT_TYPE_BY_SIDEBAR.opencode).toBe("opencode");
    expect(AGENT_TYPE_BY_SIDEBAR.kilo).toBe("kilo");
    expect(AGENT_TYPE_BY_SIDEBAR.cersei).toBe("cersei");
  });

  it("round-trips: a resumed session's band maps back to itself", () => {
    for (const [band, agentType] of Object.entries(AGENT_TYPE_BY_SIDEBAR)) {
      expect(sidebarAgentOf(agentType)).toBe(band);
    }
  });
});
