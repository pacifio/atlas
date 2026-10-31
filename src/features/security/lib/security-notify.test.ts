import { describe, expect, it } from "vitest";
import type { NotificationEnv } from "@/features/notifications/lib/decide";
import { decideSecurityFinding, type SecurityNotice } from "./security-notify";

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
});
