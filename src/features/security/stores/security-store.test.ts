import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import type { CheckpointSecurity } from "../types";
import { selectCheckpoints, useSecurityStore } from "./security-store";

const cp: CheckpointSecurity = {
  checkpointId: "cp-1",
  commitSha: "3fa91c2aaaa",
  status: "done",
  level: "critical",
  blocking: true,
  findings: [
    {
      fingerprint: "key",
      level: "critical",
      blocking: true,
      class: "secret",
      ruleId: "secret.vendor.stripe-access-token",
      reason: "A credential appears in the added code.",
      path: "server/pay.ts",
      line: 2,
      endLine: 2,
      sha: "3fa91c2aaaa",
      testCode: false,
      notUseful: false,
    },
  ],
  floors: [],
  notScanned: [],
  scannedAt: "2026-10-31T14:30:46Z",
  scanMs: 42,
};

describe("security store", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSecurityStore.setState({ sessions: {}, checkpoints: {}, byCommit: {} });
  });

  it("loads a Project's badges by session", async () => {
    invoke.mockResolvedValueOnce([
      { sessionId: "s1", level: "critical", blocking: true, findings: 1, scanned: 1 },
    ]);
    await useSecurityStore.getState().actions.loadProject("/p");
    expect(invoke).toHaveBeenCalledWith("security_project_sessions", { projectPath: "/p" });
    expect(useSecurityStore.getState().sessions["/p"].s1.level).toBe("critical");
  });

  it("marks a finding not useful at once and drops the badge", async () => {
    invoke.mockResolvedValueOnce([cp]);
    await useSecurityStore.getState().actions.loadSession("/p", "s1");
    invoke.mockResolvedValueOnce(undefined);
    await useSecurityStore.getState().actions.setNotUseful("/p", "s1", cp.findings[0], true);
    const state = useSecurityStore.getState();
    expect(selectCheckpoints(state, "/p", "s1")?.[0].findings[0].notUseful).toBe(true);
    expect(selectCheckpoints(state, "/p", "s1")?.[0].level).toBe("none");
    expect(state.sessions["/p"].s1.findings).toBe(0);
    expect(invoke).toHaveBeenLastCalledWith("security_set_not_useful", {
      projectPath: "/p",
      fingerprint: "key",
      ruleId: "secret.vendor.stripe-access-token",
      notUseful: true,
    });
  });

  it("puts the mark back when the write fails", async () => {
    invoke.mockResolvedValueOnce([cp]);
    await useSecurityStore.getState().actions.loadSession("/p", "s1");
    invoke.mockRejectedValueOnce(new Error("store locked"));
    await useSecurityStore.getState().actions.setNotUseful("/p", "s1", cp.findings[0], true);
    const after = selectCheckpoints(useSecurityStore.getState(), "/p", "s1");
    expect(after?.[0].findings[0].notUseful).toBe(false);
    expect(after?.[0].blocking).toBe(true);
  });

  it("re-reads the badges and every open session when a scan lands", async () => {
    invoke.mockResolvedValueOnce([]);
    await useSecurityStore.getState().actions.loadSession("/p", "s1");
    const answers: Record<string, unknown> = {
      security_project_sessions: [
        { sessionId: "s1", level: "critical", blocking: true, findings: 1, scanned: 1 },
      ],
      security_session_checkpoints: [cp],
    };
    invoke.mockImplementation(async (cmd: string) => answers[cmd]);
    await useSecurityStore.getState().actions.refreshProject("/p");
    const state = useSecurityStore.getState();
    expect(state.sessions["/p"].s1.level).toBe("critical");
    expect(selectCheckpoints(state, "/p", "s1")).toEqual([cp]);
    expect(invoke).not.toHaveBeenCalledWith("security_session_checkpoints", {
      projectPath: "/other",
      sessionId: "s1",
    });
  });
});
