// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "../stores/chat-store";
import { composePrompt, transcriptBeforeRemember, type MentionPastSession } from "./mentions";
import type { AtlasTranscriptMessage } from "./atlas-transcripts";
import { advertisesCommand, awaitTurnEnd, isRememberTurn } from "./remember";

const TAB = "tab-1";

describe("advertisesCommand", () => {
  it("matches an advertised name, with or without a leading slash", () => {
    expect(advertisesCommand({ availableCommands: [{ name: "remember" }] }, "remember")).toBe(true);
    expect(advertisesCommand({ availableCommands: [{ name: "/remember" }] }, "remember")).toBe(
      true,
    );
  });

  it("is false when the agent does not offer it, or has advertised nothing yet", () => {
    expect(advertisesCommand({ availableCommands: [{ name: "review" }] }, "remember")).toBe(false);
    expect(advertisesCommand({ availableCommands: [{ name: "remember-me" }] }, "remember")).toBe(
      false,
    );
    expect(advertisesCommand({ availableCommands: [null, 3, {}] }, "remember")).toBe(false);
    expect(advertisesCommand({}, "remember")).toBe(false);
    expect(advertisesCommand(undefined, "remember")).toBe(false);
  });
});

describe("isRememberTurn", () => {
  it("reads the bare command and one with a focus, and nothing else", () => {
    expect(isRememberTurn("/remember")).toBe(true);
    expect(isRememberTurn("  /remember  ")).toBe(true);
    expect(isRememberTurn("/remember the retry rule")).toBe(true);
    expect(isRememberTurn("/rememberme")).toBe(false);
    expect(isRememberTurn("please /remember this")).toBe(false);
  });
});

// A handoff after save-before-switch: the new agent gets the conversation, not
// the save request and the list of what was saved — read as a live request,
// it would have the new agent save everything again.
describe("a handoff transcript after /remember", () => {
  const msg = (role: "user" | "assistant", content: string): AtlasTranscriptMessage => ({
    role,
    content,
    timestamp: "2026-10-03T00:00:00Z",
  });
  const transcript = [
    msg("user", "what does this repo do?"),
    msg("assistant", "It scrapes hotel prices."),
    msg("user", "/remember"),
    msg("assistant", "Saved:\n- fact: it scrapes hotel prices"),
  ];

  it("ends before the last /remember turn", () => {
    expect(transcriptBeforeRemember(transcript)).toEqual(transcript.slice(0, 2));
    // A /remember the user typed earlier is part of the conversation.
    const earlier = [msg("user", "/remember"), msg("assistant", "Saved."), ...transcript];
    expect(transcriptBeforeRemember(earlier)).toEqual(earlier.slice(0, 4));
    expect(transcriptBeforeRemember(transcript.slice(0, 2))).toEqual(transcript.slice(0, 2));
  });

  const mention = (endBeforeRemember?: boolean): MentionPastSession => ({
    kind: "past_session",
    id: "acp-1",
    displayName: "Repo",
    sessionId: "acp-1",
    sessionTitle: "Repo",
    cwd: "/repo",
    ...(endBeforeRemember ? { endBeforeRemember } : {}),
  });
  const inlinedBody = async (m: MentionPastSession) => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "agent_transcripts_read" ? transcript : { prose: "", resourceLinks: [] },
    );
    await composePrompt("go on", [m]);
    const call = invoke.mock.calls.find((c) => c[0] === "compose_prompt");
    const args = call?.[1] as { mentions: { inlineBody: string }[] };
    return args.mentions[0].inlineBody;
  };

  it("is what composePrompt inlines for a mention marked endBeforeRemember", async () => {
    const body = await inlinedBody(mention(true));
    expect(body).toContain("It scrapes hotel prices.");
    expect(body).not.toContain("/remember");
    expect(body).not.toContain("Saved:");
  });

  it("leaves an ordinary past-session mention whole", async () => {
    const body = await inlinedBody(mention());
    expect(body).toContain("/remember");
    expect(body).toContain("Saved:");
  });
});

describe("awaitTurnEnd", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: null });
    useChatStore.getState().actions.createSession(TAB, "codex");
  });
  afterEach(() => vi.useRealTimers());

  const status = (s: "running" | "idle" | "error") =>
    useChatStore.getState().actions.updateSessionStatus(TAB, s);

  it("waits for the turn to start and then end, not just for idle", async () => {
    let result: string | undefined;
    void awaitTurnEnd(TAB, { timeoutMs: 10_000 }).then((r) => (result = r));
    await Promise.resolve();
    expect(result).toBeUndefined(); // idle before the turn started is not the end

    status("running");
    await Promise.resolve();
    expect(result).toBeUndefined();

    status("idle");
    await vi.waitFor(() => expect(result).toBe("finished"));
  });

  it("reports a turn that ends in an error as failed", async () => {
    const pending = awaitTurnEnd(TAB, { timeoutMs: 10_000 });
    status("running");
    status("error");
    await expect(pending).resolves.toBe("failed");
  });

  it("times out when the turn never ends", async () => {
    const pending = awaitTurnEnd(TAB, { timeoutMs: 1_000 });
    status("running");
    vi.advanceTimersByTime(1_000);
    await expect(pending).resolves.toBe("timeout");
  });

  it("gives up early on a turn that never starts", async () => {
    const pending = awaitTurnEnd(TAB, { timeoutMs: 10_000, startTimeoutMs: 500 });
    vi.advanceTimersByTime(500);
    await expect(pending).resolves.toBe("not-started");
  });

  it("does not apply the start timeout once the turn has started", async () => {
    const pending = awaitTurnEnd(TAB, { timeoutMs: 10_000, startTimeoutMs: 500 });
    status("running");
    vi.advanceTimersByTime(500);
    status("idle");
    await expect(pending).resolves.toBe("finished");
  });

  it("stops waiting when cancelled", async () => {
    const ctrl = new AbortController();
    const pending = awaitTurnEnd(TAB, { timeoutMs: 10_000, signal: ctrl.signal });
    status("running");
    ctrl.abort();
    await expect(pending).resolves.toBe("cancelled");
  });

  it("reports a session that disappears", async () => {
    const pending = awaitTurnEnd(TAB, { timeoutMs: 10_000 });
    useChatStore.getState().actions.removeSession(TAB);
    await expect(pending).resolves.toBe("gone");
  });
});
