import { describe, expect, it } from "vitest";
import {
  decideAgentNotification,
  findHistorySession,
  isSupersededTurn,
  type AgentCtx,
  type AgentNotifyEvent,
} from "./agent-notifier-rules";
import { describePermission, describeQuestion, failureBody } from "./agent-notifier-rules";
import { DEFAULT_SETTINGS, type AppSettings } from "@/features/settings/lib/app-settings";
import { prefsFromSettings } from "./prefs";
import { AWAY_IDLE_MS, computeAway, type NotificationEnv } from "./decide";

const ctx: AgentCtx = {
  tabId: "chat-1",
  sessionId: "acp-1",
  sessionTitle: "Fix the build",
  agentName: "Claude Code",
  projectId: "ws-a",
  projectName: "atlas",
  orgId: "org-1",
};
const prefs: AppSettings = DEFAULT_SETTINGS;

const away: NotificationEnv = {
  windowFocused: false,
  sinceInputMs: 999_999,
  targetVisible: false,
  projectActive: true,
  away: true,
};
const looking: NotificationEnv = {
  windowFocused: true,
  sinceInputMs: 1_000,
  targetVisible: true,
  projectActive: true,
  away: false,
};

const finished = (over: Partial<Extract<AgentNotifyEvent, { type: "turn_finished" }>> = {}) =>
  ({ type: "turn_finished", stopReason: "end_turn", nonce: 1, ...over }) as AgentNotifyEvent;
const failed: AgentNotifyEvent = { type: "turn_failed", error: "Rate limited", nonce: 2 };
const disconnected: AgentNotifyEvent = {
  type: "agent_disconnected",
  agentId: "a1",
  reason: "exit 1",
  nonce: 3,
};
const permission: AgentNotifyEvent = {
  type: "permission_requested",
  requestId: "r1",
  toolTitle: "rm -rf dist",
};

describe("decideAgentNotification", () => {
  it("announces a finished turn on every channel but sound", () => {
    const d = decideAgentNotification(finished(), ctx, away, prefs);
    expect(d?.kind).toBe("agent-done");
    expect(d?.title).toBe("Claude Code · Fix the build");
    expect(d?.channels).toEqual({
      center: true,
      toast: true,
      native: true,
      badge: true,
      sound: false,
    });
  });

  it("never notifies for a user-cancelled turn", () => {
    expect(decideAgentNotification(finished({ stopReason: "cancelled" }), ctx, away, prefs)).toBe(
      null,
    );
  });

  it("drops a finish while the user is looking at the session", () => {
    expect(decideAgentNotification(finished(), ctx, looking, prefs)).toBeNull();
  });

  it("failure reaches center, toast and the OS banner when away", () => {
    const d = decideAgentNotification(failed, ctx, away, prefs);
    expect(d?.kind).toBe("agent-failed");
    expect(d?.body).toBe("Rate limited");
    expect(d?.native).toMatchObject({ title: "Claude Code · Fix the build", body: "Rate limited" });
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: true, badge: true });
  });

  it("failure is still recorded while looking, with no banner", () => {
    const d = decideAgentNotification(failed, ctx, looking, prefs);
    expect(d?.channels).toMatchObject({ center: true, toast: false, native: false });
  });

  it("a disconnect produces center, toast and the OS banner when away", () => {
    const d = decideAgentNotification(disconnected, ctx, away, prefs);
    expect(d?.kind).toBe("agent-disconnected");
    expect(d?.title).toBe("Claude Code · Fix the build");
    expect(d?.body).toBe("The agent process stopped — restart it to continue");
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: true });
  });

  it("a permission request is the loud tier: banner with a sound", () => {
    const d = decideAgentNotification(permission, ctx, away, prefs);
    expect(d?.tier).toBe("needs-you");
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: true, sound: true });
    expect(d?.native.sound).toBe("Ping");
    expect(d?.toast.durationMs).toBeGreaterThan(5_000);
  });

  it("a permission request chimes in-app when its session is off screen", () => {
    const d = decideAgentNotification(permission, ctx, { ...looking, targetVisible: false }, prefs);
    expect(d?.channels).toMatchObject({ native: false, sound: true });
  });

  it("a focused-but-idle user (≥ 2 min) gets the banner", () => {
    const idle: NotificationEnv = {
      ...looking,
      targetVisible: false,
      sinceInputMs: AWAY_IDLE_MS,
      away: computeAway(true, AWAY_IDLE_MS),
    };
    expect(decideAgentNotification(finished(), ctx, idle, prefs)?.channels.native).toBe(true);
  });

  it("names the project only when it is not the active one", () => {
    const d = decideAgentNotification(finished(), ctx, { ...away, projectActive: false }, prefs);
    expect(d?.title).toBe("Claude Code · Fix the build");
    expect(d?.subtitle).toBe("atlas");
    expect(d?.native.subtitle).toBe("atlas");
    // On the active project there is no subtitle.
    expect(decideAgentNotification(finished(), ctx, away, prefs)?.subtitle).toBeUndefined();
  });

  it("gives each occurrence its own dedupe key", () => {
    const a = decideAgentNotification(finished({ nonce: 1 }), ctx, away, prefs);
    const b = decideAgentNotification(finished({ nonce: 2 }), ctx, away, prefs);
    expect(a?.dedupeKey).not.toBe(b?.dedupeKey);
  });
});

describe("agent prefs", () => {
  it("master off silences every kind", () => {
    for (const e of [finished(), failed, disconnected, permission]) {
      expect(
        decideAgentNotification(e, ctx, away, { ...prefs, notificationsEnabled: false }),
      ).toBeNull();
    }
  });

  it("OS banners off keeps center and toast", () => {
    const d = decideAgentNotification(failed, ctx, away, { ...prefs, notifyOutcomeNative: false });
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: false });
  });

  it("sound off removes the banner sound", () => {
    const d = decideAgentNotification(permission, ctx, away, {
      ...prefs,
      notifyNeedsYouSound: false,
    });
    expect(d?.channels).toMatchObject({ native: true, sound: false });
    expect(d?.native.sound).toBeUndefined();
  });

  it("minimum turn duration silences quick finishes only", () => {
    const p = { ...prefs, notifyAgentMinDurationMs: 30_000 };
    expect(decideAgentNotification(finished({ durationMs: 5_000 }), ctx, away, p)).toBeNull();
    expect(decideAgentNotification(finished({ durationMs: 30_000 }), ctx, away, p)).not.toBeNull();
    // Unknown duration is not silenced; failures ignore the threshold.
    expect(decideAgentNotification(finished(), ctx, away, p)).not.toBeNull();
    expect(decideAgentNotification(failed, ctx, away, p)).not.toBeNull();
  });

  it("defaults the minimum to off", () => {
    expect(DEFAULT_SETTINGS.notifyAgentMinDurationMs).toBe(0);
    expect(prefsFromSettings(prefs)["agent-done"]).toEqual({
      enabled: true,
      native: true,
      sound: true,
    });
  });
});

describe("isSupersededTurn", () => {
  it("is stale only for a turn older than the current one", () => {
    expect(isSupersededTurn(2, 3)).toBe(true);
    expect(isSupersededTurn(3, 3)).toBe(false);
    expect(isSupersededTurn(undefined, 3)).toBe(false);
    expect(isSupersededTurn(0, 3)).toBe(false);
    expect(isSupersededTurn(1, undefined)).toBe(false);
  });
});

const render = (e: AgentNotifyEvent, env = away) => {
  const d = decideAgentNotification(e, ctx, { ...env, projectActive: false }, prefs);
  return d && { title: d.native.title, subtitle: d.native.subtitle, body: d.native.body };
};

describe("turn_finished copy", () => {
  it("says what happened: summary, duration, files edited", () => {
    expect(
      render(
        finished({
          summary: "Moved token refresh into middleware",
          durationMs: 252_000,
          filesEdited: 6,
        }),
      ),
    ).toEqual({
      title: "Claude Code · Fix the build",
      subtitle: "atlas",
      body: "Moved token refresh into middleware · 4m 12s · 6 files",
    });
  });

  it("a turn without edits omits the file count", () => {
    expect(render(finished({ summary: "Explained the build", durationMs: 45_000 }))?.body).toBe(
      "Explained the build · 45s",
    );
  });

  it("falls back to stats alone with no usable text", () => {
    expect(render(finished({ summary: null, durationMs: 90_000, filesEdited: 1 }))?.body).toBe(
      "1m 30s · 1 file",
    );
  });

  it("says Done when there is nothing else to say", () => {
    expect(render(finished())?.body).toBe("Done");
  });

  it("gives each non-end_turn stop reason its own wording", () => {
    const body = (stopReason: string) =>
      render(finished({ stopReason, summary: "ignored", durationMs: 12_000, filesEdited: 2 }))
        ?.body;
    expect(body("max_tokens")).toBe("Hit the output limit · 12s · 2 files");
    expect(body("max_turn_requests")).toBe("Hit the turn limit · 12s · 2 files");
    expect(body("refusal")).toBe("Declined · 12s · 2 files");
    expect(body("end_turn")).toBe("ignored · 12s · 2 files");
  });

  it("produces nothing for a cancelled turn", () => {
    expect(render(finished({ stopReason: "cancelled", summary: "x" }))).toBeNull();
  });

  it("can no longer produce the old generic banner", () => {
    const d = decideAgentNotification(finished(), ctx, away, prefs);
    expect(d?.native.title).not.toMatch(/Atlas/);
    expect(d?.native.body).not.toMatch(/Agent task finished|Task finished/);
  });

  it("titles by agent alone when the thread has no title", () => {
    const d = decideAgentNotification(finished(), { ...ctx, sessionTitle: undefined }, away, prefs);
    expect(d?.title).toBe("Claude Code");
  });
});

describe("failure copy", () => {
  it("words each error kind", () => {
    expect(failureBody("auth", "401")).toBe("Sign-in expired — sign in again to continue");
    expect(failureBody("transient", "503")).toBe("Temporary problem — try again in a moment");
    expect(failureBody("process_dead", "")).toBe(
      "The agent process stopped — restart it to continue",
    );
    expect(failureBody("fatal", "Context window exceeded. Start a new thread.")).toBe(
      "Failed — Context window exceeded",
    );
    expect(failureBody("unknown", "Rate limited")).toBe("Rate limited");
    expect(failureBody(undefined, "")).toBe("Something went wrong");
  });

  it("routes the kind from the event", () => {
    expect(render({ type: "turn_failed", error: "x", errorKind: "auth", nonce: 1 })?.body).toBe(
      "Sign-in expired — sign in again to continue",
    );
  });
});

describe("permission copy", () => {
  it("names the tool and the command or target concisely", () => {
    expect(
      describePermission({
        kind: "execute",
        title: "npm test",
        rawInput: { command: "npm test -- --run" },
      }),
    ).toBe("Run npm test -- --run");
    expect(describePermission({ kind: "execute", title: "rm -rf dist" })).toBe("Run rm -rf dist");
    expect(
      describePermission({ kind: "edit", title: "Edit", rawInput: { file_path: "src/auth.ts" } }),
    ).toBe("Edit src/auth.ts");
    expect(describePermission({ title: "Fetch docs" })).toBe("Fetch docs");
    expect(describePermission(undefined, "tool call")).toBe("tool call");
    expect(describePermission(null)).toBe("a tool");
  });

  it("collapses whitespace and caps long commands", () => {
    const out = describePermission({
      kind: "execute",
      rawInput: { command: `echo\n${"a".repeat(200)}` },
    });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.startsWith("Run echo aaa")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("renders the permission banner", () => {
    expect(
      render({
        type: "permission_requested",
        requestId: "r",
        toolCall: { kind: "execute", title: "rm -rf dist" },
      }),
    ).toEqual({
      title: "Claude Code · Fix the build",
      subtitle: "atlas",
      body: "Needs approval — Run rm -rf dist",
    });
  });
});

describe("question copy", () => {
  const ask = (message: string): AgentNotifyEvent => ({
    type: "question_asked",
    requestId: "q1",
    message,
  });

  it("is the needs-you tier: banner with a sound when away, toast off screen", () => {
    const d = decideAgentNotification(ask("Which database?"), ctx, away, prefs);
    expect(d?.kind).toBe("agent-question");
    expect(d?.channels.center).toBe(true);
    expect(d?.channels.toast).toBe(true);
    expect(d?.channels.native).toBe(true);
    expect(d?.native?.body).toBe("Which database?");
    expect(d?.native?.sound).toBeTruthy();
    const off = decideAgentNotification(
      ask("Which database?"),
      ctx,
      { ...looking, targetVisible: false },
      prefs,
    );
    expect(off?.channels.toast).toBe(true);
  });

  it("shows the question under the agent and thread title", () => {
    const d = decideAgentNotification(
      ask("Which database?"),
      { ...ctx },
      { ...away, projectActive: false },
      prefs,
    );
    expect(d?.title).toBe("Claude Code · Fix the build");
    expect(d?.subtitle).toBe("atlas");
    expect(d?.body).toBe("Which database?");
  });

  it("collapses to one line and caps long questions", () => {
    expect(describeQuestion("Which\n\n  database   do you want?")).toBe(
      "Which database do you want?",
    );
    const out = describeQuestion(`${"word ".repeat(60)}`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
    expect(describeQuestion("  ")).toBe("Has a question for you");
  });

  it("is silenced by the master switch and the banner pref", () => {
    expect(
      decideAgentNotification(ask("q?"), ctx, away, { ...prefs, notificationsEnabled: false }),
    ).toBeNull();
    const d = decideAgentNotification(ask("q?"), ctx, away, {
      ...prefs,
      notifyNeedsYouNative: false,
    });
    expect(d?.channels.native).toBe(false);
  });
});

describe("agent sign-in required", () => {
  const signIn = (episode = 0): AgentNotifyEvent => ({
    type: "sign_in_required",
    agentType: "cursor",
    episode,
  });

  it("uses every channel when away, naming the agent", () => {
    const d = decideAgentNotification(signIn(), ctx, away, prefs);
    expect(d?.kind).toBe("agent-sign-in");
    expect(d?.tier).toBe("needs-you");
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: true, badge: true });
    expect(d?.title).toBe("Sign in to Claude Code");
    expect(d?.native.title).toBe("Sign in to Claude Code");
    expect(d?.native.sound).toBe("Ping");
  });

  it("routes the click to that agent's sign-in, not a thread", () => {
    const d = decideAgentNotification(signIn(), ctx, away, prefs);
    expect(d?.target).toEqual({ type: "agent-sign-in", agentType: "cursor" });
    expect(d?.groupKey).toBe("agent-sign-in:cursor");
  });

  it("keeps the center record and toast even on the thread's own tab", () => {
    const d = decideAgentNotification(signIn(), ctx, looking, prefs);
    expect(d?.channels.center).toBe(true);
  });

  it("repeats within an episode share one dedupe key; a new episode differs", () => {
    const key = (e: AgentNotifyEvent, c: AgentCtx = ctx) =>
      decideAgentNotification(e, c, away, prefs)?.dedupeKey;
    expect(key(signIn(0))).toBe(key(signIn(0)));
    // Another thread of the same agent is the same problem.
    expect(key(signIn(0), { ...ctx, tabId: "chat-2", sessionId: "acp-2" })).toBe(key(signIn(0)));
    expect(key(signIn(1))).not.toBe(key(signIn(0)));
  });

  it("is silenced by the master switch and the banner pref", () => {
    expect(
      decideAgentNotification(signIn(), ctx, away, { ...prefs, notificationsEnabled: false }),
    ).toBeNull();
    const d = decideAgentNotification(signIn(), ctx, away, {
      ...prefs,
      notifyNeedsYouNative: false,
    });
    expect(d?.channels.native).toBe(false);
  });
});

describe("pull request watch", () => {
  const wake: AgentNotifyEvent = { type: "pull_request_watch", summary: "#12: merged", nonce: "t" };
  const noTab: AgentCtx = { tabId: "", sessionId: "acp-9", threadId: "thread-9" };

  it("notifies for a session no tab shows, with a target that opens it by thread id", () => {
    const d = decideAgentNotification(wake, noTab, { ...looking, targetVisible: false }, prefs);
    expect(d?.kind).toBe("pull-request-watch");
    expect(d?.target).toEqual({
      type: "session",
      tabId: "",
      sessionId: "acp-9",
      threadId: "thread-9",
    });
  });

  it("drops for the session in view", () => {
    expect(decideAgentNotification(wake, ctx, looking, prefs)).toBeNull();
  });
});

describe("findHistorySession", () => {
  const row = (threadId: string, sessionId: string | null) =>
    ({ threadId, sessionId }) as unknown as import("@/features/chat/lib/history-api").ThreadRow;
  const groups = [
    { name: "a", paths: ["/a"], isCurrent: false, threads: [row("t1", "s1")] },
    { name: "b", paths: ["/b"], isCurrent: true, threads: [row("t2", "s2")] },
  ];

  it("finds a row by thread id, else by session id, with its group's paths", () => {
    expect(findHistorySession(groups, "t2")).toEqual({
      row: groups[1]!.threads[0],
      groupPaths: ["/b"],
    });
    expect(findHistorySession(groups, "missing", "s1")?.groupPaths).toEqual(["/a"]);
    expect(findHistorySession(groups, "missing", "nope")).toBeNull();
  });
});
