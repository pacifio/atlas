import { describe, expect, it } from "vitest";
import type { ToolCallView, TurnView } from "@tryatlas/design/session";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";
import { projectRows, RowKind, type MarkerRow, type ProjectOptions } from "./turn-rows";
import {
  assembleSessionView,
  toSessionView,
  toToolCallView,
  type TranscriptSessionView,
} from "./session-view-adapter";

const AT = "2026-11-05T10:00:00.000Z";

function msg(m: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: AT,
    ...m,
  } as ChatMessage;
}

function call(tc: Partial<ToolCallDisplay> & Pick<ToolCallDisplay, "id">): ToolCallDisplay {
  return {
    toolName: "read_file",
    kind: "read",
    status: "completed",
    arguments: {},
    result: null,
    duration: null,
    ...tc,
  } as ToolCallDisplay;
}

/** Every assistant turn in these fixtures starts at `a1`; its work is held open. */
function opts(o: Partial<ProjectOptions> = {}): ProjectOptions {
  return {
    expanded: new Set(),
    streaming: false,
    expandedTurns: new Set(["wk:t:a1", "wk:t:a2"]),
    ...o,
  };
}

function view(messages: ChatMessage[], o?: Partial<ProjectOptions>, prev?: TranscriptSessionView) {
  const projection = projectRows(messages, opts(o));
  const sv = toSessionView(
    { messages, projection, phase: o?.streaming ? "running" : "done", agentLabel: "Agent" },
    prev,
  );
  return { projection, sv };
}

const toolsOf = (sv: TranscriptSessionView): ToolCallView[] =>
  [...sv.byRow.values()].flatMap((t) =>
    t.items.flatMap((i) => (i.kind === "tool" ? [i.call] : [])),
  );

/** A marker for `toToolCallView` alone. */
function marker(m: Partial<MarkerRow>): MarkerRow {
  return {
    kind: RowKind.Marker,
    id: "mk:x",
    turnId: "t:a1",
    firstInTurn: false,
    verb: "Used",
    tool: "tool",
    detail: "",
    state: "done",
    toolCallId: "x",
    opens: "none",
    added: 0,
    removed: 0,
    startedAt: undefined,
    ...m,
  };
}

describe("row kinds", () => {
  it("maps a prompt, with its images as data URLs and its @-context as one file", () => {
    const { sv } = view([
      msg({
        id: "u1",
        role: "user",
        content: "look",
        attachments: [{ mimeType: "image/png", dataBase64: "AAA" }],
        atlasProse: "look",
        atlasContext: "ctx",
        atlasContextBlockCount: 2,
      }),
    ]);
    const turn = sv.byRow.get("u:u1")!;
    expect(turn.key).toBe("u1");
    expect(turn.items).toEqual([]);
    expect(turn.user?.id).toBe("u1");
    expect(turn.user?.attachments?.[0]).toEqual({
      kind: "image",
      mimeType: "image/png",
      src: "data:image/png;base64,AAA",
    });
    expect(turn.user?.attachments?.[1]).toEqual({ kind: "file", name: "2 attached" });
  });

  it("maps prose, with the model line only on the turn's first answer", () => {
    const { sv } = view([
      msg({ id: "u1", role: "user", content: "hi" }),
      msg({ id: "a1", role: "assistant", content: "First", mode: "text" }),
      msg({
        id: "a2",
        role: "assistant",
        content: "Second",
        mode: "tool",
        toolCalls: [call({ id: "c1" })],
      }),
      msg({ id: "a3", role: "assistant", content: "Third", mode: "text", model: "gpt-5" }),
    ]);
    const first = sv.byRow.get("p:a1")!.items[0];
    expect(first).toMatchObject({ kind: "text", id: "a1", text: "First", model: "Agent" });
    const third = sv.byRow.get("p:a3")!.items[0];
    expect(third).toMatchObject({ kind: "text", id: "a3", text: "Third" });
    expect("model" in third && third.model).toBeFalsy();
  });

  it("maps a collapsed thought to the message's text", () => {
    const { sv } = view([
      msg({ id: "u1", role: "user", content: "hi" }),
      msg({ id: "a1", role: "assistant", mode: "thinking", thinking: "Weighing it up" }),
      msg({ id: "a2", role: "assistant", content: "Done", mode: "text" }),
    ]);
    expect(sv.byRow.get("th:a1")!.items).toEqual([
      { kind: "thinking", id: "a1", text: "Weighing it up" },
    ]);
  });

  it("gives work headers, separators and footers no entry", () => {
    const { projection, sv } = view([
      msg({ id: "u1", role: "user", content: "hi" }),
      msg({ id: "a1", role: "assistant", content: "Done", mode: "text" }),
      msg({ id: "a2", role: "assistant", mode: "tool", toolCalls: [call({ id: "c1" })] }),
    ]);
    const content: number[] = [
      RowKind.User,
      RowKind.Prose,
      RowKind.Thinking,
      RowKind.MarkerGroup,
      RowKind.Marker,
    ];
    expect(projection.rows.some((r) => !content.includes(r.kind))).toBe(true);
    for (const row of projection.rows) {
      expect(sv.byRow.has(row.id)).toBe(content.includes(row.kind));
    }
  });

  it("maps a settled turn's lone call, which stands as a bare marker row", () => {
    const { projection, sv } = view([
      msg({ id: "u1", role: "user", content: "go" }),
      msg({
        id: "a1",
        role: "assistant",
        mode: "tool",
        toolCalls: [call({ id: "solo", arguments: { file_path: "/repo/a.ts" }, result: "x" })],
      }),
    ]);
    const lone = projection.rows.find((r) => r.kind === RowKind.Marker)!;
    expect(lone).toBeDefined();
    expect(sv.byRow.get(lone.id)!.items).toMatchObject([
      { kind: "tool", call: { id: "solo", kind: "read", status: "completed" } },
    ]);
  });
});

describe("tool calls", () => {
  it.each([
    ["run", "execute"],
    ["read", "read"],
    ["list", "read"],
    ["edit", "edit"],
    ["delete", "delete"],
    ["move", "move"],
    ["search", "search"],
    ["fetch", "fetch"],
    ["think", "think"],
    ["file", "other"],
    ["org", "other"],
    ["memory", "other"],
    ["browser", "other"],
    ["tool", "other"],
  ] as const)("maps the %s glyph to the %s kind", (tool, kind) => {
    expect(toToolCallView(call({ id: "x" }), marker({ tool })).kind).toBe(kind);
  });

  it("draws a shell call as a terminal, with no input or output", () => {
    const tc = call({
      id: "c1",
      toolName: "Bash",
      kind: "execute",
      arguments: { command: "bun run build" },
      result: "ok",
    });
    const v = toToolCallView(tc, marker({ verb: "Ran", tool: "run", detail: "bun run build" }));
    expect(v.terminal).toEqual({ command: "bun run build", output: "ok" });
    expect(v.input).toBeUndefined();
    expect(v.output).toBeUndefined();
    expect(v.title).toBe("Ran bun run build");
  });

  it("maps an MCP call with no kind to other, and a delegate to think", () => {
    const { sv } = view(
      [
        msg({ id: "u1", role: "user", content: "go" }),
        msg({
          id: "a1",
          role: "assistant",
          mode: "tool",
          toolCalls: [
            call({
              id: "mcp",
              toolName: "mcp__github__create_issue",
              kind: null,
              arguments: { title: "Bug" },
            }),
            call({ id: "del", toolName: "Task", kind: "think", arguments: { prompt: "x" } }),
          ],
        }),
      ],
      { streaming: true },
    );
    const [mcp, del] = toolsOf(sv);
    expect(mcp.kind).toBe("other");
    expect(mcp.input?.text).toBe(JSON.stringify({ title: "Bug" }, null, 2));
    expect(del.kind).toBe("think");
  });

  it("carries an edit's counts as one diff with no texts", () => {
    const tc = call({ id: "e1", toolName: "Edit", kind: "edit" });
    const v = toToolCallView(
      tc,
      marker({
        verb: "Edited",
        tool: "edit",
        detail: "button.tsx",
        path: "/repo/src/button.tsx",
        opens: "diff",
        added: 6,
        removed: 2,
      }),
    );
    expect(v.diffs).toEqual([
      { path: "/repo/src/button.tsx", insertions: 6, deletions: 2, change: "modified" },
    ]);
    expect(v.paths).toEqual(["/repo/src/button.tsx"]);
    const created = toToolCallView(
      tc,
      marker({ verb: "Created", tool: "edit", path: "/repo/new.ts", opens: "diff" }),
    );
    expect(created.diffs?.[0].change).toBe("added");
  });

  it("keeps a failed call failed, whether it failed or a cancel swept it", () => {
    const { sv } = view([
      msg({ id: "u1", role: "user", content: "go" }),
      msg({
        id: "a1",
        role: "assistant",
        mode: "tool",
        toolCalls: [
          call({ id: "f1", status: "failed", result: "exit 1" }),
          // `turn_finished` cancelled sweeps a live call to failed, result unset.
          call({ id: "f2", status: "failed", result: null }),
        ],
      }),
    ]);
    expect(toolsOf(sv).map((c) => c.status)).toEqual(["failed", "failed"]);
  });

  it("passes a huge output through untouched", () => {
    const huge = Array.from({ length: 50_000 }, (_, i) => `out ${i}`).join("\n");
    const v = toToolCallView(call({ id: "h", result: huge }), marker({}));
    expect(v.output?.text).toBe(huge);
  });

  it("stamps the call's start and duration", () => {
    const v = toToolCallView(
      call({ id: "d", startedAt: Date.parse(AT), endedAt: Date.parse(AT) + 1500 }),
      marker({ durationMs: 1500 }),
    );
    expect(v.at).toBe(AT);
    expect(v.durationMs).toBe(1500);
  });
});

describe("streaming", () => {
  it("names the streaming tail's item", () => {
    const { sv } = view(
      [
        msg({ id: "u1", role: "user", content: "hi" }),
        msg({ id: "a1", role: "assistant", content: "Typing", mode: "text" }),
      ],
      { streaming: true },
    );
    expect(sv.streaming).toEqual({ itemId: "a1", activity: "text" });
  });

  it("names a streaming thought when no answer follows it", () => {
    const { sv } = view(
      [
        msg({ id: "u1", role: "user", content: "hi" }),
        msg({ id: "a1", role: "assistant", mode: "thinking", thinking: "Hmm" }),
      ],
      { streaming: true },
    );
    expect(sv.streaming).toEqual({ itemId: "a1", activity: "thinking" });
  });

  it("has none when settled", () => {
    const { sv } = view([
      msg({ id: "u1", role: "user", content: "hi" }),
      msg({ id: "a1", role: "assistant", content: "Done", mode: "text" }),
    ]);
    expect(sv.streaming).toBeUndefined();
  });
});

describe("structural sharing", () => {
  const base = [
    msg({ id: "u1", role: "user", content: "hi" }),
    msg({ id: "a1", role: "assistant", content: "Reading.", mode: "text" }),
    msg({
      id: "a2",
      role: "assistant",
      mode: "tool",
      toolCalls: [
        call({ id: "r1", toolName: "Bash", kind: "execute", status: "running", result: "a" }),
      ],
    }),
    msg({ id: "a3", role: "assistant", content: "So far", mode: "text" }),
  ];

  it("reuses every entry but the streaming tail's when text is appended", () => {
    const projA = projectRows(base, opts({ streaming: true }));
    const svA = toSessionView({
      messages: base,
      projection: projA,
      phase: "running",
      agentLabel: "Agent",
    });

    const grown = [...base.slice(0, 3), { ...base[3], content: "So far, so good" }];
    const projB = projectRows(grown, opts({ streaming: true }), projA);
    const svB = toSessionView(
      { messages: grown, projection: projB, phase: "running", agentLabel: "Agent" },
      svA,
    );

    for (const [id, turn] of svB.byRow) {
      if (id === "p:a3") expect(turn).not.toBe(svA.byRow.get(id));
      else expect(turn).toBe(svA.byRow.get(id));
    }
    const tail = svB.byRow.get("p:a3")!.items[0];
    expect(tail.kind === "text" && tail.text).toBe("So far, so good");
  });

  it("changes only the group whose running call's output grew", () => {
    const projB = projectRows(base, opts({ streaming: true }));
    const svB = toSessionView({
      messages: base,
      projection: projB,
      phase: "running",
      agentLabel: "Agent",
    });

    // Output streams by replacing the call, not the marker row.
    const a2 = base[2];
    const grownCall = { ...a2.toolCalls[0], result: "a\nb" };
    const outputGrew = [...base.slice(0, 2), { ...a2, toolCalls: [grownCall] }, base[3]];
    const projC = projectRows(outputGrew, opts({ streaming: true }), projB);
    const svC = toSessionView(
      { messages: outputGrew, projection: projC, phase: "running", agentLabel: "Agent" },
      svB,
    );

    const group = projC.rows.find((r) => r.kind === RowKind.MarkerGroup)!;
    for (const [id, turn] of svC.byRow) {
      if (id === group.id) expect(turn).not.toBe(svB.byRow.get(id));
      else expect(turn).toBe(svB.byRow.get(id));
    }
    expect(toolsOf(svC)[0].terminal?.output).toBe("a\nb");
  });
});

describe("structural sharing, beyond the row", () => {
  const settled = [
    msg({ id: "u1", role: "user", content: "hi" }),
    msg({ id: "a1", role: "assistant", mode: "thinking", thinking: "First" }),
    msg({ id: "a2", role: "assistant", content: "Answer", mode: "text" }),
  ];
  it("rebuilds the model line when the agent's label changes", () => {
    const projection = projectRows(settled, opts());
    const input = { messages: settled, projection, phase: "done" as const };
    const a = toSessionView({ ...input, agentLabel: "Agent" });
    const b = toSessionView({ ...input, agentLabel: "Codex" }, a);
    const line = b.byRow.get("p:a2")!.items[0];
    expect(line.kind === "text" && line.model).toBe("Codex");
    expect(b.byRow.get("u:u1")).toBe(a.byRow.get("u:u1"));
  });

  it("rebuilds a collapsed thought whose text grew", () => {
    const projA = projectRows(settled, opts());
    const a = toSessionView({
      messages: settled,
      projection: projA,
      phase: "done",
      agentLabel: "A",
    });
    // Same headline, so the collapsed row comes back as the same object.
    const grown = [settled[0], { ...settled[1], thinking: "First\n\nthen more" }, settled[2]];
    const projB = projectRows(grown, opts(), projA);
    expect(projB.rows.find((r) => r.id === "th:a1")).toBe(projA.rows.find((r) => r.id === "th:a1"));
    const b = toSessionView(
      { messages: grown, projection: projB, phase: "done", agentLabel: "A" },
      a,
    );
    const thought = b.byRow.get("th:a1")!.items[0];
    expect(thought.kind === "thinking" && thought.text).toBe("First\n\nthen more");
  });
});

describe("assembleSessionView", () => {
  it("opens a turn at each prompt, keyed by its message id", () => {
    const messages = [
      msg({ id: "a0", role: "assistant", content: "Before any prompt", mode: "text" }),
      msg({ id: "u1", role: "user", content: "one" }),
      msg({ id: "a1", role: "assistant", content: "Answer one", mode: "text" }),
      msg({ id: "u2", role: "user", content: "two" }),
      msg({ id: "a2", role: "assistant", content: "Answer two", mode: "text" }),
    ];
    const { projection, sv } = view(messages, {
      expandedTurns: new Set(["wk:t:a0", "wk:t:a1", "wk:t:a2"]),
    });
    const session = assembleSessionView(sv, projection.rows);
    expect(session.turns.map((t: TurnView) => t.key)).toEqual(["pre", "u1", "u2"]);
    expect(session.turns[1].user?.text).toBe("one");
    expect(session.turns[1].items.map((i) => i.kind === "text" && i.text)).toEqual(["Answer one"]);
    expect(session).toMatchObject({ phase: "done", meta: {} });
  });
});
