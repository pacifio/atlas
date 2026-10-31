import { describe, expect, it } from "vitest";
import type { CheckpointSecurity, SecurityFinding } from "../types";
import { badgeVariant, levelLabel, recount, shouldShowBadge } from "./security-levels";
import { blockingNotices } from "./security-notify";

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  fingerprint: "fp-1",
  level: "medium",
  blocking: false,
  class: "install_script",
  ruleId: "pkg.install_script",
  reason: "A package install script was added, which runs code when dependencies install.",
  path: "package.json",
  line: 1,
  endLine: 1,
  sha: "159c989d0000",
  testCode: false,
  notUseful: false,
  ...over,
});

const checkpoint = (findings: SecurityFinding[]): CheckpointSecurity => ({
  checkpointId: "cp-1",
  commitSha: "159c989d0000",
  status: "done",
  level: "none",
  blocking: false,
  findings,
  floors: [],
  notScanned: [],
  scannedAt: "2026-10-31T14:30:46Z",
  scanMs: 16,
});

describe("badge levels", () => {
  it("names each level for the badge", () => {
    expect(levelLabel("critical")).toBe("Critical");
    expect(levelLabel("medium")).toBe("Medium");
  });

  it("colours by severity with the status roles", () => {
    expect(badgeVariant("critical")).toBe("destructive");
    expect(badgeVariant("high")).toBe("warning");
    expect(badgeVariant("medium")).toBe("warning");
    expect(badgeVariant("low")).toBe("info");
  });

  it("shows a badge only when something still counts", () => {
    expect(
      shouldShowBadge({ sessionId: "s", level: "none", blocking: false, findings: 0, scanned: 2 }),
    ).toBe(false);
    expect(
      shouldShowBadge({
        sessionId: "s",
        level: "medium",
        blocking: false,
        findings: 1,
        scanned: 1,
      }),
    ).toBe(true);
    expect(shouldShowBadge(undefined)).toBe(false);
  });

  it("recounts a checkpoint when a finding is marked not useful", () => {
    const cp = checkpoint([
      finding({ fingerprint: "a", level: "critical", blocking: true, notUseful: true }),
      finding({ fingerprint: "b", level: "medium" }),
    ]);
    const r = recount(cp);
    expect(r.level).toBe("medium");
    expect(r.blocking).toBe(false);
    expect(recount(checkpoint([finding({ notUseful: true })])).level).toBe("none");
  });
});

describe("blocking notices", () => {
  it("announces each blocking finding once", () => {
    const cp = checkpoint([
      finding({
        fingerprint: "key",
        level: "critical",
        blocking: true,
        class: "secret",
        ruleId: "secret.vendor.stripe-access-token",
        path: "server/pay.ts",
        line: 2,
      }),
      finding({ fingerprint: "pkg", level: "medium" }),
    ]);
    const announced = new Set<string>();
    const first = blockingNotices([cp], announced);
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe("A credential was committed");
    expect(first[0].body).toContain("server/pay.ts, line 2");
    expect(first[0].body).toContain("159c989");
    expect(first[0].fingerprint).toBe("key");
    expect(blockingNotices([cp], announced)).toHaveLength(0);
  });

  it("stays quiet for findings marked not useful or not blocking", () => {
    const cp = checkpoint([
      finding({ fingerprint: "x", level: "critical", blocking: true, notUseful: true }),
      finding({ fingerprint: "y", level: "high", blocking: false }),
    ]);
    expect(blockingNotices([cp], new Set())).toHaveLength(0);
  });

  it("names the issue plainly for other blocking classes", () => {
    const cp = checkpoint([
      finding({
        fingerprint: "tls",
        level: "high",
        blocking: true,
        class: "tls_disabled",
        ruleId: "rust.tls.accept_invalid",
        path: "src/client.rs",
        line: 14,
        reason: "Certificate checks are turned off for a network connection.",
      }),
    ]);
    const [n] = blockingNotices([cp], new Set());
    expect(n.title).toBe("A blocking security issue was committed");
    expect(n.body).toContain("Certificate checks are turned off");
  });

  it("skips scans that ran before it started listening", () => {
    const old = checkpoint([finding({ fingerprint: "old", level: "critical", blocking: true })]);
    const fresh = {
      ...checkpoint([finding({ fingerprint: "new", level: "critical", blocking: true })]),
      checkpointId: "cp-2",
      scannedAt: "2026-10-31T15:00:00Z",
    };
    const since = Date.parse("2026-10-31T14:45:00Z");
    const notices = blockingNotices([old, fresh], new Set(), since);
    expect(notices.map((n) => n.fingerprint)).toEqual(["new"]);
  });
});
