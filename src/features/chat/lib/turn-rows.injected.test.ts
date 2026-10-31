import { describe, expect, it } from "vitest";
import { projectRows, RowKind } from "./turn-rows";
import { detectInjectedPrompt } from "./injected-prompt";
import { latestResponseRowId } from "./message-footer";
import type { ChatMessage } from "@/types/agent";

const OPTS = { expanded: new Set<string>(), streaming: false, expandedTurns: new Set<string>() };

function msg(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    role,
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-23T00:00:00Z",
    mode: role === "assistant" ? "text" : undefined,
  } as ChatMessage;
}

const WAKE =
  "Update on pull request #12 (https://github.com/acme/shop/pull/12), which Atlas is watching for you:\n- Check failed: test";

describe("a prompt Atlas sent on its own", () => {
  it("opens its turn as an injected row, not the user's bubble", () => {
    const wake = {
      ...msg("u2", "user", WAKE),
      injected: { source: "pull-request-watch" as const, summary: "#12: checks failed" },
    };
    const { rows, turns } = projectRows(
      [
        msg("u1", "user", "open a PR"),
        msg("a1", "assistant", "done"),
        wake,
        msg("a2", "assistant", "fixing"),
      ],
      OPTS,
    );
    const row = rows.find((r) => r.id === "u:u2");
    expect(row).toMatchObject({
      kind: RowKind.Injected,
      firstInTurn: true,
      injected: { summary: "#12: checks failed" },
      text: WAKE,
    });
    const turn = turns.find((t) => t.id === "t:u2");
    expect(turn).toMatchObject({ role: "user", preview: "Pull request watch: #12: checks failed" });
    // The reply below it is the latest response, as after any prompt.
    expect(latestResponseRowId(rows)).toBe(
      rows.find((r) => r.kind === RowKind.Prose && r.text === "fixing")?.id,
    );
  });

  it("is recognised by its wording when the session is replayed", () => {
    const { rows } = projectRows([msg("u1", "user", WAKE)], OPTS);
    expect(rows[0]).toMatchObject({
      kind: RowKind.Injected,
      injected: { source: "pull-request-watch", summary: "#12: update" },
    });
  });

  it("leaves the user's own words alone, even about a pull request", () => {
    const { rows } = projectRows([msg("u1", "user", "Update on pull request #12 please")], OPTS);
    expect(rows[0].kind).toBe(RowKind.User);
  });
});

describe("detectInjectedPrompt", () => {
  it("knows each of the watch's wakes", () => {
    expect(detectInjectedPrompt(WAKE)?.summary).toBe("#12: update");
    expect(
      detectInjectedPrompt(
        "Pull request #4 (https://github.com/a/b/pull/4) was closed, so Atlas stopped watching it. Call watch_pull_request if it reopens.",
      )?.summary,
    ).toBe("#4: closed");
    expect(
      detectInjectedPrompt(
        "Atlas stopped watching pull request #9 (https://github.com/a/b/pull/9) because it failed to read it from the host 8 times in a row.",
      )?.summary,
    ).toBe("#9: stopped watching, could not read it");
    expect(detectInjectedPrompt("fix the build")).toBeNull();
  });
});

describe("a turn continued after a restart", () => {
  it("replays as the restart row, not the user's bubble", () => {
    expect(
      detectInjectedPrompt("Atlas restarted while you were working. Continue where you left off."),
    ).toEqual({
      source: "restart",
      summary: "Atlas restarted and resumed this turn",
    });
    // Only the exact prompt: the user typing the common phrase themselves,
    // alone or in a longer message, stays theirs.
    expect(detectInjectedPrompt("Continue where you left off.")).toBeNull();
    expect(detectInjectedPrompt("Continue where you left off. Then run the tests.")).toBeNull();
    const { rows, turns } = projectRows(
      [
        msg("u1", "user", "refactor the store"),
        msg("a1", "assistant", "working"),
        msg("u2", "user", "Atlas restarted while you were working. Continue where you left off."),
        msg("a2", "assistant", "picking it back up"),
      ],
      OPTS,
    );
    expect(rows.find((r) => r.id === "u:u2")?.kind).toBe(RowKind.Injected);
    expect(turns.find((t) => t.messageIndex === 2)?.preview).toBe(
      "Atlas restarted and resumed this turn",
    );
  });
});
