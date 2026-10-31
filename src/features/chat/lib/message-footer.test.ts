import { describe, expect, it } from "vitest";
import { latestResponseRowId, responseFooterActions, userFooterActions } from "./message-footer";
import { RowKind, type Row } from "./turn-rows";

describe("userFooterActions", () => {
  it("keeps pin and copy inline and tucks edit into the menu", () => {
    expect(userFooterActions({ canRetry: false })).toEqual({
      inline: ["pin", "copy", "comment"],
      overflow: ["edit"],
    });
  });

  it("leads with retry on the retryable prompt", () => {
    expect(userFooterActions({ canRetry: true })).toEqual({
      inline: ["retry", "pin", "copy", "comment"],
      overflow: ["edit"],
    });
  });

  it("never offers branch on a prompt", () => {
    for (const canRetry of [false, true]) {
      const { inline, overflow } = userFooterActions({ canRetry });
      expect([...inline, ...overflow]).not.toContain("branch");
    }
  });
});

describe("responseFooterActions", () => {
  it("keeps copy and pin inline, with no menu", () => {
    expect(responseFooterActions({ canBranch: false })).toEqual({
      inline: ["copy", "pin", "comment"],
      overflow: [],
    });
  });

  it("adds branch after copy on the latest response", () => {
    expect(responseFooterActions({ canBranch: true })).toEqual({
      inline: ["copy", "branch", "pin", "comment"],
      overflow: [],
    });
  });

  it("never offers retry or edit on a response", () => {
    for (const canBranch of [false, true]) {
      const { inline, overflow } = responseFooterActions({ canBranch });
      expect([...inline, ...overflow]).not.toContain("retry");
      expect([...inline, ...overflow]).not.toContain("edit");
    }
  });
});

describe("pin never moves", () => {
  // Pin is one stable inline toggle on both kinds. If a future change puts it
  // in the menu, pressing it would unmount the control being activated and
  // drop keyboard focus — the reason it left the menu.
  it("is inline and never in the menu, on prompts and responses", () => {
    for (const flag of [false, true]) {
      const user = userFooterActions({ canRetry: flag });
      const response = responseFooterActions({ canBranch: flag });
      expect(user.inline).toContain("pin");
      expect(user.overflow).not.toContain("pin");
      expect(response.inline).toContain("pin");
      expect(response.overflow).not.toContain("pin");
    }
  });
});

describe("latestResponseRowId", () => {
  const base = { turnId: "t", firstInTurn: false };
  const user = (id: string): Row => ({
    ...base,
    id,
    kind: RowKind.User,
    text: "q",
    contextBlocks: 0,
    expanded: false,
    attachments: [],
    timestamp: "2026-10-24T09:00:00Z",
  });
  const prose = (id: string, streaming = false): Row => ({
    ...base,
    id,
    kind: RowKind.Prose,
    text: "a",
    streaming,
    showHeader: false,
    model: null,
    timestamp: "2026-10-24T09:00:00Z",
  });
  const separator = (id: string) => ({ ...base, id, kind: RowKind.Separator }) as unknown as Row;

  it("picks the last prose row of the last exchange", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1"), prose("p:2")])).toBe("p:2");
  });

  it("looks past trailing non-prose rows", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1"), separator("s:1")])).toBe("p:1");
  });

  it("offers nothing while the response is still streaming", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1", true)])).toBeUndefined();
  });

  it("offers nothing when the last prompt has no answer yet", () => {
    expect(latestResponseRowId([user("u:1"), prose("p:1"), user("u:2")])).toBeUndefined();
  });

  it("offers nothing on an empty session", () => {
    expect(latestResponseRowId([])).toBeUndefined();
  });
});
