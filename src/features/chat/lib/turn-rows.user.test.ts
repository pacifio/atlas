import { describe, expect, it } from "vitest";
import {
  projectRows,
  RowKind,
  userMessageText,
  type Projection,
  type ProjectOptions,
  type Row,
  type UserRow,
} from "./turn-rows";
import { appendNextStepsDirective } from "./next-steps";
import type { ChatMessage } from "@/types/agent";

// The user half of the transcript projection, and the guarantee the whole
// projection makes to the virtualized list: rows that did not change between
// two frames come back as the SAME objects, so their memo'd views skip.

const OPTS: ProjectOptions = {
  expanded: new Set<string>(),
  streaming: false,
  expandedTurns: new Set<string>(),
};

const T0 = Date.parse("2026-09-18T09:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function user(id: string, content: string, minutes = 0, extra: Partial<ChatMessage> = {}) {
  return {
    id,
    role: "user",
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(minutes),
    ...extra,
  } as ChatMessage;
}

function assistant(id: string, content: string, minutes = 0, extra: Partial<ChatMessage> = {}) {
  return {
    id,
    role: "assistant",
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(minutes),
    mode: "text",
    ...extra,
  } as ChatMessage;
}

const rowsOf = (messages: ChatMessage[], opts = OPTS) => projectRows(messages, opts).rows;
const userRows = (rows: Row[]) => rows.filter((r): r is UserRow => r.kind === RowKind.User);
const bubble = (content: string, extra: Partial<ChatMessage> = {}) =>
  userRows(rowsOf([user("u1", content, 0, extra)]))[0];

const CONTEXT =
  "\n\n---\n# Atlas context\n\n## @src/app.ts\n\nconst a = 1;\n\n## @notes/plan\n\nShip it.";
const MEMORY =
  "--- SHARED MEMORY ---\nThe user prefers pnpm.\n--- END SHARED MEMORY ---\n" +
  "--- RECENT SESSION ---\nYesterday: fixed the build.\n--- END RECENT SESSION ---\n";

describe("what a user bubble shows", () => {
  it("shows plain prose trimmed, with no context chip", () => {
    expect(bubble("  fix the build  \n")).toMatchObject({
      text: "fix the build",
      contextBlocks: 0,
    });
  });

  it("hides the @-mention context behind a chip that counts its blocks", () => {
    expect(bubble(`fix the build${CONTEXT}`)).toMatchObject({
      text: "fix the build",
      contextBlocks: 2,
    });
  });

  it("uses the split the store made at insert time over re-parsing the content", () => {
    // `addMessage` pre-splits; the projection must trust it rather than parse
    // `content` again (which here would disagree on purpose).
    const row = bubble(`raw body${CONTEXT}`, {
      atlasProse: "the prose the store kept",
      atlasContext: "## @a\n\nx",
      atlasContextBlockCount: 1,
    });
    expect(row).toMatchObject({ text: "the prose the store kept", contextBlocks: 1 });
  });

  it("drops the memory blocks Atlas injected into the prompt", () => {
    expect(bubble(`${MEMORY}\nfix the build`).text).toBe("fix the build");
  });

  it("drops the next-steps directive a resumed transcript echoes back", () => {
    expect(bubble(appendNextStepsDirective("fix the build")).text).toBe("fix the build");
  });

  it("drops all three at once, in the order a resumed wire prompt carries them", () => {
    const wire = appendNextStepsDirective(`${MEMORY}\nfix the build${CONTEXT}`);
    expect(bubble(wire)).toMatchObject({ text: "fix the build", contextBlocks: 2 });
  });

  it("is the text a pin records", () => {
    const m = user("u1", appendNextStepsDirective(`${MEMORY}\nfix the build${CONTEXT}`));
    expect(userMessageText(m)).toBe("fix the build");
    expect(userMessageText(m)).toBe(userRows(rowsOf([m]))[0].text);
  });

  it("gives the nav rail a one-line preview of at most 80 characters", () => {
    const long = `first line\n\n${"word ".repeat(40)}`;
    const { turns } = projectRows([user("u1", long)], OPTS);
    expect(turns[0].preview).not.toMatch(/\n/);
    expect(turns[0].preview.startsWith("first line word")).toBe(true);
    expect(turns[0].preview.length).toBe(80);
  });

  it("carries the images, the timestamp and the row/message id link", () => {
    const row = bubble("look", {
      attachments: [
        { mimeType: "image/png", dataBase64: "AA==" },
        { mimeType: "image/png", dataBase64: "AA==" },
      ],
    });
    expect(row).toMatchObject({ id: "u:u1", turnId: "t:u1", timestamp: at(0) });
    expect(row.attachments).toHaveLength(2);
  });

  it("names the remote-control driver who sent a prompt, and nobody for the window's own", () => {
    expect(bubble("own").remoteAuthor).toBeNull();
    expect(bubble("own", { origin: { kind: "local" } }).remoteAuthor).toBeNull();
    expect(
      bubble("theirs", { origin: { kind: "remote", id: "u2", name: "Ada" } }).remoteAuthor,
    ).toBe("Ada");
    // A driver the room never named is still not this window.
    expect(bubble("theirs", { origin: { kind: "remote", id: "u2" } }).remoteAuthor).toBe(
      "Someone else",
    );
  });

  it("is expanded only when the reader expanded that bubble", () => {
    const messages = [user("u1", "a"), user("u2", "b")];
    const rows = userRows(rowsOf(messages, { ...OPTS, expanded: new Set(["u:u2"]) }));
    expect(rows.map((r) => r.expanded)).toEqual([false, true]);
  });

  // A user prompt only ever carries the injected directive, so user text
  // strips just that — a user's own mention of the tag survives.
  it("keeps a user's own mention of the <next_steps> tag", () => {
    expect(bubble("why does the <next_steps> block leak into replies?").text).toBe(
      "why does the <next_steps> block leak into replies?",
    );
  });
});

describe("messages that render nothing", () => {
  it.each([
    ["an empty user message", user("u2", "")],
    ["a whitespace-only user message", user("u2", "  \n\t")],
    ["an empty assistant message", assistant("a1", "")],
    [
      "a signature-only thinking marker",
      assistant("a1", "", 0, { mode: "thinking", thinking: " " }),
    ],
    ["an assistant message with an empty plan", assistant("a1", "", 0, { plan: [] })],
  ])("drops %s from the row index", (_label, empty) => {
    const { rows, turns } = projectRows([user("u1", "hi"), empty], OPTS);
    expect(rows.map((r) => r.id)).toEqual(["u:u1"]);
    expect(turns.map((t) => t.id)).toEqual(["t:u1"]);
  });

  it("adds no row for an empty streaming tail, and makes it the live turn once text arrives", () => {
    const opts = { ...OPTS, streaming: true };
    const waiting = projectRows([user("u1", "hi"), assistant("a1", "")], opts);
    expect(waiting.rows.map((r) => r.id)).toEqual(["u:u1"]);
    const next = projectRows([user("u1", "hi"), assistant("a1", "He")], opts);
    expect(next.turns.map((t) => [t.id, t.status])).toEqual([
      ["t:u1", "settled"],
      ["t:a1", "streaming"],
    ]);
  });

  it("skips an empty message inside an assistant run without splitting the turn", () => {
    const { rows, turns } = projectRows(
      [
        user("u1", "hi"),
        assistant("a1", "one"),
        assistant("a2", "", 0, { mode: "thinking", thinking: "" }),
        assistant("a3", "two"),
      ],
      OPTS,
    );
    expect(rows.map((r) => r.id)).toEqual(["u:u1", "p:a1", "p:a3"]);
    expect(turns.map((t) => t.id)).toEqual(["t:u1", "t:a1"]);
  });
});

describe("gap separators", () => {
  it("marks a pause of more than twenty minutes before the turn that follows it", () => {
    const { rows, turns } = projectRows(
      [user("u1", "first", 0), assistant("a1", "ok", 1), user("u2", "back", 45)],
      OPTS,
    );
    expect(rows.map((r) => r.id)).toEqual(["u:u1", "p:a1", "gs:u2", "u:u2"]);
    const sep = rows[2];
    expect(sep).toMatchObject({
      kind: RowKind.Separator,
      label: "44m ago",
      turnId: "t:u2",
      firstInTurn: false,
    });
    // The separator sits BETWEEN turns: the turn starts at the bubble.
    const second = turns.find((t) => t.id === "t:u2")!;
    expect(rows[second.rowStart].id).toBe("u:u2");
    expect(rows[second.rowStart].firstInTurn).toBe(true);
  });

  it("does not mark a pause of exactly twenty minutes", () => {
    const rows = rowsOf([user("u1", "a", 0), user("u2", "b", 20)]);
    expect(rows.some((r) => r.kind === RowKind.Separator)).toBe(false);
  });

  it("marks a slow reply too, before the assistant turn", () => {
    const rows = rowsOf([user("u1", "a", 0), assistant("a1", "sorry, slow", 30)]);
    expect(rows.map((r) => r.id)).toEqual(["u:u1", "gs:a1", "p:a1"]);
  });

  it("never marks the first message", () => {
    expect(rowsOf([user("u1", "a", 0)]).map((r) => r.kind)).toEqual([RowKind.User]);
  });

  it.each([
    [21, "21m ago"],
    [90, "2h ago"],
    [3 * 24 * 60, "3d ago"],
  ])("labels a %d-minute pause %s", (minutes, label) => {
    const rows = rowsOf([user("u1", "a", 0), user("u2", "b", minutes)]);
    expect(rows.find((r) => r.kind === RowKind.Separator)).toMatchObject({ label });
  });
});

describe("rows are identity-stable between projections", () => {
  const thread = () => [
    user("u1", `fix the build${CONTEXT}`, 0),
    assistant("a1", "Looking.", 1),
    user("u2", "and the tests", 40),
    assistant("a2", "On it", 41),
  ];

  /** What immer hands the next frame: a new array, the same objects for every
   *  settled message, and a fresh object for the one that changed. */
  function nextFrame(messages: ChatMessage[], index: number, change: Partial<ChatMessage>) {
    const copy = [...messages];
    copy[index] = { ...messages[index], ...change };
    return copy;
  }

  const same = (a: Projection, b: Projection) => b.rows.map((row, i) => row === a.rows[i]);

  it("returns every row and turn object from the previous frame when nothing changed", () => {
    const messages = thread();
    const first = projectRows(messages, OPTS);
    const second = projectRows([...messages], OPTS, first);
    expect(same(first, second)).toEqual(first.rows.map(() => true));
    expect(second.turns.every((t, i) => t === first.turns[i])).toBe(true);
  });

  it("re-mints only the streaming tail's row when a chunk arrives", () => {
    const opts = { ...OPTS, streaming: true };
    const messages = thread();
    const first = projectRows(messages, opts);
    const second = projectRows(nextFrame(messages, 3, { content: "On it now" }), opts, first);
    expect(second.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    // The live turn's work header is stable too; only the prose under it moves.
    expect(same(first, second)).toEqual([true, true, true, true, true, false]);
    expect(second.rows[4]).toMatchObject({ kind: RowKind.WorkHeader, live: true });
    expect(second.rows[5]).toMatchObject({ kind: RowKind.Prose, text: "On it now" });
    // The settled turns are the same objects; only the live one moved.
    expect(second.turns.map((t, i) => t === first.turns[i])).toEqual([true, true, true, true]);
  });

  it("re-mints only the bubble the reader expanded", () => {
    const messages = thread();
    const first = projectRows(messages, OPTS);
    const second = projectRows(messages, { ...OPTS, expanded: new Set(["u:u2"]) }, first);
    const changed = second.rows.filter((row, i) => row !== first.rows[i]).map((r) => r.id);
    expect(changed).toEqual(["u:u2"]);
  });

  it("keeps every earlier row when a new turn is appended", () => {
    const messages = thread();
    const first = projectRows(messages, OPTS);
    const second = projectRows([...messages, user("u3", "thanks", 42)], OPTS, first);
    expect(second.rows.slice(0, first.rows.length).every((r, i) => r === first.rows[i])).toBe(true);
    expect(second.rows).toHaveLength(first.rows.length + 1);
  });

  it("never mutates a row it handed out in an earlier frame", () => {
    const messages = thread();
    const first = projectRows(messages, OPTS);
    const snapshot = JSON.stringify(first.rows);
    projectRows(nextFrame(messages, 0, { content: "rewritten" }), OPTS, first);
    projectRows(messages.slice(2), OPTS, first);
    expect(JSON.stringify(first.rows)).toBe(snapshot);
  });

  it("re-derives a user bubble whose message object changed", () => {
    const messages = thread();
    const first = projectRows(messages, OPTS);
    const second = projectRows(nextFrame(messages, 2, { content: "and the lint" }), OPTS, first);
    const u2 = userRows(second.rows).find((r) => r.id === "u:u2")!;
    expect(u2.text).toBe("and the lint");
    expect(u2).not.toBe(userRows(first.rows).find((r) => r.id === "u:u2"));
  });
});
