// The capture indicator's rules, one case each — and the one that matters
// most: a faulted project never reads as healthy.

import { describe, expect, it } from "vitest";

import type { Binding, CaptureHealth, HealthState } from "../types";
import { captureIndicator } from "./capture-indicator";

const binding = (enabled: boolean): Binding => ({
  workspaceId: "ws_1",
  root: "/p",
  mode: "local",
  slug: null,
  orgId: null,
  rootCommitSha: null,
  fingerprintIsShallow: false,
  gitUrl: null,
  enabled,
  importApproved: true,
  drainState: "ok",
  remoteWorkspaceId: null,
  createdAt: "2026-01-01T00:00:00Z",
});

const health = (state: HealthState): CaptureHealth => ({
  state,
  summary: state,
  issues: [],
  flaggedSessions: 0,
  failedRows: 0,
  pendingRows: 0,
});

describe("captureIndicator", () => {
  it("no binding is not set up", () => {
    expect(captureIndicator(null, health("stopped"))).toEqual({
      kind: "unbound",
      tone: "neutral",
      live: false,
      label: "Not set up",
    });
  });

  it("a disabled binding is paused, whatever the health", () => {
    expect(captureIndicator(binding(false), health("degraded"))).toMatchObject({
      kind: "paused",
      tone: "neutral",
      live: false,
      label: "Paused",
    });
  });

  it("stopped health is stopped, in the error tone", () => {
    expect(captureIndicator(binding(true), health("stopped"))).toEqual({
      kind: "stopped",
      tone: "error",
      live: false,
      label: "Stopped",
    });
  });

  it("degraded health needs attention, in the warning tone", () => {
    expect(captureIndicator(binding(true), health("degraded"))).toEqual({
      kind: "degraded",
      tone: "warning",
      live: false,
      label: "Needs attention",
    });
  });

  it("ok health is capturing, and the only live state", () => {
    expect(captureIndicator(binding(true), health("ok"))).toEqual({
      kind: "capturing",
      tone: "success",
      live: true,
      label: "Capturing",
    });
  });

  it("null health on an enabled binding is capturing (the read has not answered)", () => {
    expect(captureIndicator(binding(true), null).kind).toBe("capturing");
  });

  it("off health on an enabled binding is capturing — off is not a fault", () => {
    expect(captureIndicator(binding(true), health("off")).kind).toBe("capturing");
  });

  it("never shows the success tone or the word Capturing while faulted", () => {
    for (const state of ["degraded", "stopped"] as const) {
      const indicator = captureIndicator(binding(true), health(state));
      expect(indicator.tone).not.toBe("success");
      expect(indicator.label).not.toMatch(/capturing/i);
      expect(indicator.live).toBe(false);
    }
  });
});
