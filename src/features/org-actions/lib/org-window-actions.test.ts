// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const writeSpacePage = vi.hoisted(() => vi.fn(async () => ({ nodes: 1, edges: 0 })));
vi.mock("@/features/spaces/lib/space-page-write", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/spaces/lib/space-page-write")>();
  return { ...real, writeSpacePage };
});
vi.mock("@/features/spaces/lib/live-spaces", () => ({ appSpaceTransport: {} }));

const { useCommsStore } = await import("@/features/comms/stores/comms-store");
const { performOrgWindowAction } = await import("./org-window-actions");

const request = (orgId: string) => ({
  requestId: "r-1",
  sessionId: "s1",
  agent: "atlas-agent",
  cwd: "/p",
  tool: "org_page_write",
  args: {
    org_id: orgId,
    conversation_id: "conv-1",
    page_id: "page-1",
    document: { nodes: [{ id: "a", kind: "note", text: "hi" }], edges: [] },
  },
});

function chatOn(orgId: string | null) {
  useCommsStore.setState({
    connection: { ...useCommsStore.getState().connection, orgId },
  } as never);
}

beforeEach(() => writeSpacePage.mockClear());

describe("org_page_write in the window", () => {
  /// ADR-0014: a call acts in the Project's organisation, never the window's.
  /// The window's Space socket is its chat's, so a call for another
  /// organisation is refused rather than drawn in the wrong one.
  it("refuses when the window's chat is on another organisation, and draws nothing", async () => {
    chatOn("org-globex");
    const reply = await performOrgWindowAction(request("org-acme"));
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error).toMatch(/not on this chat's organization.*Nothing was drawn/);
    expect(writeSpacePage).not.toHaveBeenCalled();
  });

  it("refuses when the window has no organisation chat at all", async () => {
    chatOn(null);
    const reply = await performOrgWindowAction(request("org-acme"));
    expect(reply.ok).toBe(false);
    expect(writeSpacePage).not.toHaveBeenCalled();
  });

  it("draws when the window's chat is on the call's organisation", async () => {
    chatOn("org-acme");
    const reply = await performOrgWindowAction(request("org-acme"));
    expect(reply.ok).toBe(true);
    expect(writeSpacePage).toHaveBeenCalledTimes(1);
  });
});
