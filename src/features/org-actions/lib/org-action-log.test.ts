// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The settings store subscribes to config events when it loads.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { useLogStore } from "@/features/log/stores/log-store";
import { logOrgAction } from "./org-action-log";
import type { OrgActionRecord } from "./types";

beforeEach(() => {
  useLogStore.setState({ buffer: [] });
});

function record(partial: Partial<OrgActionRecord>): OrgActionRecord {
  return {
    sessionId: "s1",
    agent: "atlas-agent",
    tool: "org_whoami",
    arguments: {},
    ok: true,
    text: JSON.stringify({ organisation: { id: "org-acme", name: "Acme" } }),
    ...partial,
  };
}

const orgRows = () => useLogStore.getState().buffer.filter((e) => e.kind === "agent-org-action");

/// The Logs panel is the audit trail: one row per organisation call, naming
/// the tool, what it was about, and how it ended.
describe("the Logs row of an organisation call", () => {
  it("is one row naming the tool, the subject and the outcome", () => {
    logOrgAction(record({}));
    const rows = orgRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("agent");
    expect(rows[0].summary).toBe("atlas-agent org_whoami: Who am I in Acme");
    expect(rows[0].payload).toMatchObject({
      sessionId: "s1",
      tool: "org_whoami",
      subject: "Who am I in Acme",
      status: "success",
    });
  });

  it("a refused call is a row that says why", () => {
    logOrgAction(
      record({
        ok: false,
        text: "Atlas Agent's organisation access is switched off in Settings → General; ask the user to turn it on.",
      }),
    );
    const [row] = orgRows();
    expect(row.summary).toBe(
      "atlas-agent org_whoami: Who am I failed: Atlas Agent's organisation access is switched off in Settings → General; ask the user to turn it on.",
    );
    expect(row.payload).toMatchObject({
      status: "failure",
      error: expect.stringContaining("switched off"),
    });
  });

  it("a failed lookup names what was looked up and why it failed", () => {
    logOrgAction(
      record({
        tool: "org_members",
        arguments: { name: "Sam Lee" },
        ok: false,
        text: JSON.stringify({
          error: '"Sam Lee" matches 2 members; ask the user which one',
          candidates: [],
        }),
      }),
    );
    const [row] = orgRows();
    expect(row.summary).toBe(
      'atlas-agent org_members: Looked up Sam Lee failed: "Sam Lee" matches 2 members; ask the user which one',
    );
    expect(row.payload).toMatchObject({ args: { name: "Sam Lee" }, subject: "Looked up Sam Lee" });
  });
});
