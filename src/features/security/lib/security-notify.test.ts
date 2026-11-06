import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import type { NotificationEnv } from "@/features/notifications/lib/decide";
import { runNotificationAction } from "@/features/notifications/lib/notification-actions";
import { decideSecurityFinding, type SecurityNotice } from "./security-notify";
import "./security-notifier";

const env = (over: Partial<NotificationEnv> = {}): NotificationEnv => ({
  windowFocused: false,
  sinceInputMs: 1_000,
  targetVisible: false,
  projectActive: true,
  away: true,
  ...over,
});

const notice: SecurityNotice = {
  fingerprint: "key",
  ruleId: "secret.vendor.stripe-access-token",
  checkpointId: "cp-1",
  commitSha: "3fa91c2aaaa",
  title: "A credential was committed",
  body: "Found in server/pay.ts, line 2, commit 3fa91c2. Remove it and rotate the key before you push.",
};

describe("the blocking-finding notification", () => {
  it("opens the session at the commit's Checkpoint, once per finding", () => {
    const d = decideSecurityFinding(notice, { projectPath: "/p", sessionId: "s1" }, env(), {});
    expect(d?.kind).toBe("security-finding");
    expect(d?.title).toBe("A credential was committed");
    expect(d?.target).toEqual({
      type: "timeline-session",
      projectPath: "/p",
      sessionId: "s1",
      commitSha: "3fa91c2aaaa",
    });
    expect(d?.dedupeKey).toBe("security:/p:key");
  });

  it("is silenced by its Settings switch", () => {
    const d = decideSecurityFinding(notice, { projectPath: "/p", sessionId: "s1" }, env(), {
      "security-finding": { enabled: false, native: true, sound: true },
    });
    expect(d).toBeNull();
  });

  it("offers Not useful beside Open, and pressing it marks the finding", async () => {
    const d = decideSecurityFinding(notice, { projectPath: "/p", sessionId: "s1" }, env(), {});
    expect(d?.actions.map((a) => a.label)).toEqual(["Open", "Not useful"]);
    const action = d!.actions[1];
    invoke.mockResolvedValue(undefined);
    await runNotificationAction(action.id, { target: d!.target, args: action.args });
    expect(invoke).toHaveBeenCalledWith("security_set_not_useful", {
      projectPath: "/p",
      fingerprint: "key",
      ruleId: "secret.vendor.stripe-access-token",
      notUseful: true,
    });
  });
});
