import { describe, expect, it } from "vitest";
import type { NotificationTarget } from "./catalog";
import {
  bannerActionArgs,
  bannerTarget,
  encodeBannerPayload,
  targetForResponse,
} from "./native-routing";

const click = (payload: string | null, actionId: string | null = null) => ({
  tag: "t",
  actionId,
  payload,
});

describe("banner payload round trip", () => {
  it("rebuilds a terminal target in another project", () => {
    const target: NotificationTarget = {
      type: "terminal",
      tabId: "tab-1",
      terminalId: "pty-2",
      projectId: "proj-b",
      projectName: "b",
    };
    expect(targetForResponse(click(encodeBannerPayload(target)))).toEqual(target);
  });

  it("rebuilds an agent session target", () => {
    const target: NotificationTarget = { type: "session", tabId: "tab-9", sessionId: "s" };
    expect(targetForResponse(click(encodeBannerPayload(target)))).toEqual(target);
  });

  it("rebuilds the app-level targets (sign-in, Chat), which own no tab", () => {
    for (const target of [
      { type: "atlas-sign-in" },
      { type: "agent-sign-in", agentType: "cursor" },
      { type: "chat-conversation", convId: "c1", orgId: "o" },
      { type: "app-update" },
      { type: "settings", section: "models" },
      { type: "settings", section: "agents" },
      { type: "config-file" },
      { type: "git-panel", projectId: "p1", projectName: "Atlas" },
    ] satisfies NotificationTarget[]) {
      expect(targetForResponse(click(encodeBannerPayload(target)))).toEqual(target);
    }
  });
});

describe("targetForResponse", () => {
  const good = encodeBannerPayload({ type: "session", tabId: "t" });

  it("ignores action-button responses", () => {
    expect(targetForResponse(click(good, "allow"))).toBeNull();
  });

  it("ignores missing, malformed and foreign payloads", () => {
    expect(targetForResponse(click(null))).toBeNull();
    expect(targetForResponse(click("{not json"))).toBeNull();
    expect(targetForResponse(click('"str"'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"session"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"terminal","tabId":"t"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"x","tabId":"t"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"git-panel"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"settings","section":"x"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"agent-sign-in"}}'))).toBeNull();
  });
});

describe("bannerTarget", () => {
  it("returns the target for an action button too — what its handler runs against", () => {
    const target: NotificationTarget = { type: "git-panel", projectId: "p1" };
    const payload = encodeBannerPayload(target);
    expect(bannerTarget(click(payload, "git.choose-pull"))).toEqual(target);
    expect(bannerTarget(click(payload))).toEqual(target);
    // A plain click still routes through targetForResponse; a button does not.
    expect(targetForResponse(click(payload, "git.choose-pull"))).toBeNull();
  });

  it("is null for a missing, malformed or foreign payload", () => {
    expect(bannerTarget(click(null, "x"))).toBeNull();
    expect(bannerTarget(click("{", "x"))).toBeNull();
    expect(bannerTarget(click('{"target":{"type":"nope"}}', "x"))).toBeNull();
  });
});

describe("bannerActionArgs", () => {
  const target: NotificationTarget = { type: "settings", section: "agents" };
  const payload = encodeBannerPayload(target, undefined, [
    { id: "agents.retry-update", label: "Retry", args: { pluginId: "cursor" } },
    { id: "open", label: "Open" },
  ]);

  it("returns the pressed button's args", () => {
    expect(bannerActionArgs(click(payload, "agents.retry-update"))).toEqual({ pluginId: "cursor" });
    expect(bannerTarget(click(payload, "agents.retry-update"))).toEqual(target);
  });

  it("is undefined for a plain click, a button without args, or a bad payload", () => {
    expect(bannerActionArgs(click(payload))).toBeUndefined();
    expect(bannerActionArgs(click(payload, "open"))).toBeUndefined();
    expect(bannerActionArgs(click("{", "x"))).toBeUndefined();
    expect(bannerActionArgs(click('{"args":{"x":{"a":1}}}', "x"))).toBeUndefined();
  });

  it("leaves the payload without args when no action has any", () => {
    expect(
      JSON.parse(encodeBannerPayload(target, undefined, [{ id: "open", label: "Open" }])),
    ).toEqual({
      v: 1,
      target,
    });
  });
});
