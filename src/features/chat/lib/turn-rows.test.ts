import { describe, expect, it } from "vitest";
import {
  projectRows,
  RowKind,
  type MarkerGroupRow,
  type MarkerRow,
  type ProjectOptions,
  type WorkHeaderRow,
} from "./turn-rows";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

/** Every fixture's assistant turn starts at message `m1`, and a settled turn
 *  folds its work behind its header — opened here so the rows under test are
 *  projected at all. Folding itself is tested in its own block below. */
const OPEN_WORK = "wk:t:m1";

const OPTS = {
  expanded: new Set<string>(),
  streaming: false,
  expandedTurns: new Set<string>([OPEN_WORK]),
};

function toolCall(tc: Partial<ToolCallDisplay>): ToolCallDisplay {
  return {
    id: "tc1",
    toolName: "write_file",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    contentBlocks: [],
    ...tc,
  } as ToolCallDisplay;
}

function turn(...toolCalls: ToolCallDisplay[]): ChatMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      content: "",
      toolCalls,
      fileChanges: [],
      plan: null,
      timestamp: "2026-08-23T00:00:00Z",
      mode: "tool",
    } as ChatMessage,
  ];
}

function markers(messages: ChatMessage[]): MarkerRow[] {
  return projectRows(messages, OPTS).rows.flatMap((row) =>
    row.kind === RowKind.MarkerGroup ? row.markers : [],
  );
}

describe("a tool call that reports its edit as a diff content block", () => {
  // The ACP shape: the agent's own tool has whatever name and arguments it
  // likes, and the edit is reported structurally as a `diff` block. Nothing in
  // `arguments` says "this wrote a file", so every marker field has to come
  // from the block — which is what the transcript used to miss entirely.
  const diffCall = toolCall({
    id: "tc-diff",
    toolName: "apply_patch",
    arguments: { patch_id: 7 },
    contentBlocks: [
      {
        type: "diff",
        path: "/repo/src/app.ts",
        oldText: "one\ntwo\n",
        newText: "one\ntwo\nthree\nfour\n",
      },
    ],
  });

  it("opens the diff viewer", () => {
    expect(markers(turn(diffCall))[0].opens).toBe("diff");
  });

  it("names the file it changed", () => {
    const m = markers(turn(diffCall))[0];
    expect(m.verb).toBe("Edited");
    expect(m.detail).toBe("src/app.ts");
    expect(m.path).toBe("/repo/src/app.ts");
  });

  it("counts the lines the block actually changed", () => {
    const m = markers(turn(diffCall))[0];
    expect(m.added).toBe(2);
    expect(m.removed).toBe(0);
  });

  it("reads as Created when the block has no old text", () => {
    const created = toolCall({
      id: "tc-new",
      toolName: "apply_patch",
      contentBlocks: [{ type: "diff", path: "/repo/src/new.ts", newText: "hello\n" }],
    });
    const m = markers(turn(created))[0];
    expect(m.verb).toBe("Created");
    // `oldText` is ABSENT for a created file — the wire skips it rather than
    // sending null (`atlas-agent-wire`), which is what "created" means here.
    expect(m.added).toBe(1);
    expect(m.removed).toBe(0);
  });

  it("still prefers recognisable edit arguments when it has both", () => {
    // A tool Atlas already understands must not change how it reads just
    // because the agent also attached the diff.
    const both = toolCall({
      id: "tc-both",
      toolName: "Write",
      arguments: { file_path: "/repo/src/known.ts", content: "a\n" },
      contentBlocks: [{ type: "diff", path: "/repo/src/other.ts", newText: "z\n" }],
    });
    const m = markers(turn(both))[0];
    expect(m.detail).toBe("src/known.ts");
    expect(m.path).toBe("/repo/src/known.ts");
  });

  it("leaves a terminal block alone — it is output, not a diff", () => {
    const term = toolCall({
      id: "tc-term",
      toolName: "run",
      result: "hello",
      contentBlocks: [{ type: "terminal", terminalId: "t1" }],
    });
    expect(markers(turn(term))[0].opens).toBe("output");
  });

  it("counts a line rewritten twice once, not once per block", () => {
    // `oldText`/`newText` are the WHOLE file either side, so summing blocks
    // counts intermediate states the reader never sees. Rewriting the same
    // line twice is one changed line in the diff they will actually open.
    const twice = toolCall({
      id: "tc-twice",
      contentBlocks: [
        { type: "diff", path: "/repo/src/a.ts", oldText: "a\n", newText: "b\n" },
        { type: "diff", path: "/repo/src/a.ts", oldText: "b\n", newText: "c\n" },
      ],
    });
    const m = markers(turn(twice))[0];
    expect(m.added).toBe(1);
    expect(m.removed).toBe(1);
  });

  it("reads as Edited when the file existed but was empty", () => {
    // The wire OMITS `oldText` for a created file; an empty string means a
    // real file that happened to have no content.
    const emptied = toolCall({
      id: "tc-empty",
      contentBlocks: [{ type: "diff", path: "/repo/src/e.ts", oldText: "", newText: "now\n" }],
    });
    expect(markers(turn(emptied))[0].verb).toBe("Edited");
  });
});

describe("a tool call that ran a terminal", () => {
  it("can be opened before it has printed anything", () => {
    // A running command's marker has to be clickable from the start — the
    // whole point of the output pane is watching it stream in. Keying off
    // `result` made it dead until the first byte arrived.
    const running = toolCall({
      id: "tc-run",
      toolName: "run",
      status: "running",
      result: null,
      contentBlocks: [{ type: "terminal", terminalId: "t1" }],
    });
    expect(markers(turn(running))[0].opens).toBe("output");
  });
});

describe("an edit that only a diff block named", () => {
  // This used to assert the folded block's "N modified / +N", which the
  // one-line summary dropped. The mechanism it was really guarding is the
  // marker's own counts — the block only ever summed those — so the guard now
  // sits where the numbers are produced rather than where they were displayed.
  it("reaches the marker's counts the same way an Edit tool call does", () => {
    const m = markers(
      turn(
        toolCall({
          id: "tc-diff",
          toolName: "apply_patch",
          contentBlocks: [{ type: "diff", path: "/repo/a.ts", oldText: "x\n", newText: "y\nz\n" }],
        }),
      ),
    )[0];
    expect([m.verb, m.tool]).toEqual(["Edited", "edit"]);
    expect(m.path).toBe("/repo/a.ts");
    expect([m.added, m.removed]).toEqual([2, 1]);
  });
});

describe("the icon a marker leads with", () => {
  // The icon is picked in the same pass as the verb, from the same signals, so
  // the two can never disagree — a row that says "Ran" cannot draw a book. The
  // pairs below are exactly the branches of `markerFor`.
  it("follows the verb for every call the verb branches recognise", () => {
    const cases: Array<[ToolCallDisplay, string, string]> = [
      [toolCall({ kind: "execute", arguments: { command: "cargo build" } }), "Ran", "run"],
      [
        toolCall({
          kind: "edit",
          toolName: "write",
          arguments: { file_path: "/a.ts", content: "x" },
        }),
        "Created",
        "edit",
      ],
      [
        toolCall({ kind: "read", toolName: "read", arguments: { file_path: "/a.ts" } }),
        "Read",
        "read",
      ],
      [
        toolCall({ kind: null, toolName: "rg", arguments: { pattern: "foo" } }),
        "Searched",
        "search",
      ],
    ];
    for (const [tc, verb, tool] of cases) {
      const m = markers(turn(tc))[0];
      expect([m.verb, m.tool]).toEqual([verb, tool]);
    }
  });

  it("falls back to the ACP kind for a tool it has no verb for", () => {
    // An MCP tool Atlas has never heard of still reports `kind`, and that is
    // the protocol's own answer — better than anything the name could tell us.
    const m = markers(turn(toolCall({ kind: "fetch", toolName: "acme__lookup" })))[0];
    expect(m.tool).toBe("fetch");
    expect(m.verb).toBe("acme__lookup");
  });

  it("sniffs the name only when there is no kind at all", () => {
    expect(markers(turn(toolCall({ kind: null, toolName: "web_search" })))[0].tool).toBe("search");
    expect(markers(turn(toolCall({ kind: null, toolName: "fetch_url" })))[0].tool).toBe("fetch");
  });

  /// The native agent reports MCP calls as kind "other" (Atlas's own servers
  /// are not fetches), so the name decides: a UI action is the generic tool,
  /// a memory search is a search.
  it("gives Atlas's own tool servers the icon their names earn", () => {
    const ui = markers(turn(toolCall({ kind: "other", toolName: "atlas_ui.ui_focus" })))[0];
    expect(ui.tool).toBe("tool");
    const memory = markers(
      turn(toolCall({ kind: "other", toolName: "atlas_memory.memory_search" })),
    )[0];
    expect(memory.tool).toBe("search");
  });

  /// An organisation call (ADR-0014) is one row like a UI action, wearing the
  /// organisation icon and naming what it was about; the table itself is
  /// tested in `org-actions/lib/org-tool-rows.test.ts`.
  it("gives an organisation call the organisation icon and a one-line subject", () => {
    const answer = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ member: { name: "Grace Hopper" } }) }],
    });
    const [row] = markers(
      turn(
        toolCall({
          kind: "other",
          toolName: "atlas_org.org_members",
          arguments: { name: "grace@acme.dev" },
          result: answer,
        }),
      ),
    );
    expect(row.tool).toBe("org");
    expect(row.verb).toBe("Looked up");
    expect(row.detail).toBe("Grace Hopper");
    expect(row.opens).toBe("output");
  });

  it("names an organisation call that failed by what it asked, in the failed state", () => {
    const [row] = markers(
      turn(
        toolCall({
          kind: "other",
          toolName: "atlas_org.org_conversations",
          status: "failed",
          arguments: { name: "#design" },
          result: '{"error":"\\"#design\\" matches 2 conversations; ask the user which one"}',
        }),
      ),
    );
    expect(row.tool).toBe("org");
    expect(row.state).toBe("failed");
    expect(`${row.verb} ${row.detail}`).toBe("Looked up #design");
  });

  it("does not sniff substrings out of unrelated names", () => {
    // The guard on the sniff list: "confirm" contains "rm", "webhook" contains
    // "web". A wrong icon is worse than the generic one.
    expect(markers(turn(toolCall({ kind: null, toolName: "confirm_order" })))[0].tool).toBe("tool");
    expect(markers(turn(toolCall({ kind: null, toolName: "webhook_send" })))[0].tool).toBe("tool");
  });

  it("uses the neutral page when a call names a file but not what it did to it", () => {
    const m = markers(
      turn(toolCall({ kind: null, toolName: "acme__stat", arguments: { path: "/a.ts" } })),
    )[0];
    expect(m.tool).toBe("file");
  });
});

describe("a shell call is classified by its command, not its tool name", () => {
  // Every one of these is the same `execute` tool. Before the command was
  // parsed they all rendered "Ran" behind one terminal glyph, which is the
  // complaint this answers — see `parse-shell-command.ts`.
  const ran = (command: string) =>
    markers(turn(toolCall({ kind: "execute", arguments: { command } })))[0];

  it("gives a shell read the same verb and glyph as a read tool", () => {
    const m = ran("sed -n '1,120p' src/features/chat/lib/turn-rows.ts");
    expect([m.verb, m.tool]).toEqual(["Read", "read"]);
    // Shortened by Atlas's own rule, not upstream's — one path format across
    // the whole transcript.
    expect(m.detail).toBe("lib/turn-rows.ts");
  });

  it("shows a search as its pattern and where it looked", () => {
    const m = ran("rg 'TODO' src/features");
    expect([m.verb, m.tool]).toEqual(["Searched", "search"]);
    expect(m.detail).toBe("TODO in src/features");
  });

  it("keeps the command itself on rows it could not reduce", () => {
    const m = ran("cargo test -p atlas-memory && ./scripts/check.sh");
    expect([m.verb, m.tool]).toEqual(["Ran", "run"]);
    expect(m.detail).toBe("cargo test -p atlas-memory && ./scripts/check.sh");
  });

  it("keeps the raw command reachable once the verb has replaced it", () => {
    // `detail` now says which file was read, so the command that read it would
    // otherwise be lost until the panel is opened.
    expect(ran("cat README.md").cmd).toBe("cat README.md");
    // A "Ran" row already shows its command; a tooltip repeating it is noise.
    expect(ran("cargo build").cmd).toBeUndefined();
  });

  it("still opens the output panel whatever the command turned out to be", () => {
    expect(ran("cat README.md").opens).toBe("output");
  });
});

describe("the folded block's one-line summary", () => {
  const groupOf = (...commands: string[]) => {
    const rows = projectRows(
      turn(
        ...commands.map((command, n) =>
          toolCall({ id: `c${n}`, kind: "execute", arguments: { command } }),
        ),
      ),
      OPTS,
    ).rows;
    return rows.find((r): r is MarkerGroupRow => r.kind === RowKind.MarkerGroup);
  };

  it("names each thing the turn did, in a fixed order", () => {
    const g = groupOf("cargo build", "make test", "cat a.ts", "cat b.ts");
    expect(g?.summary).toBe("Read files, ran commands");
  });

  it("leads with the first bucket in the sentence, not the commonest", () => {
    // Six commands to two reads, and the sentence still opens with the reads:
    // the observed Codex summary led with a wrench over six terminal rows.
    const g = groupOf("cat a.ts", "cat b.ts", "make", "make", "make", "make", "make", "make");
    expect(g?.summary).toBe("Read files, ran commands");
  });

  it("counts a search toward having read files", () => {
    // The screenshot's turn read exactly one file by glyph yet said "read
    // files" — only the search alongside it makes that plural add up.
    const g = groupOf("cat ci.yml", "rg 'bazzite' .");
    expect(g?.summary).toBe("Read files");
  });

  it("uses the singular for a bucket with one call in it", () => {
    expect(groupOf("cargo build")?.summary).toBe("Ran a command");
    expect(groupOf("cat a.ts")?.summary).toBe("Read a file");
  });

  it("puts a tool call first and a command last, whatever the order they ran", () => {
    const rows = projectRows(
      turn(
        toolCall({ id: "a", kind: "execute", arguments: { command: "make" } }),
        toolCall({ id: "b", kind: null, toolName: "acme__load_skill" }),
        toolCall({
          id: "c",
          kind: "edit",
          toolName: "write",
          arguments: { file_path: "/a.ts", content: "x" },
        }),
      ),
      OPTS,
    ).rows;
    const g = rows.find((r): r is MarkerGroupRow => r.kind === RowKind.MarkerGroup);
    expect(g?.summary).toBe("Loaded a tool, edited a file, ran a command");
  });
});

describe("tool activity in the transcript", () => {
  const message = (id: string, content: string, calls: ToolCallDisplay[] = []): ChatMessage => ({
    ...turn()[0],
    id,
    content,
    toolCalls: calls,
  });

  it("keeps each tool sequence between the prose that surrounds it", () => {
    const rows = projectRows(
      [
        message("m1", "First observation"),
        message("m2", "", [toolCall({ id: "a", kind: "execute", arguments: { command: "pwd" } })]),
        message("m3", "Second observation"),
        message("m4", "", [toolCall({ id: "b", kind: "execute", arguments: { command: "ls" } })]),
        message("m5", "Conclusion"),
      ],
      OPTS,
    ).rows;
    expect(rows.map((row) => row.kind)).toEqual([
      RowKind.WorkHeader,
      RowKind.Prose,
      RowKind.MarkerGroup,
      RowKind.Prose,
      RowKind.MarkerGroup,
      RowKind.Prose,
    ]);
    const groups = rows.filter((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    expect(groups.map((group) => group.markers.map((marker) => marker.toolCallId))).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(groups.map((group) => group.open)).toEqual([false, false]);
    expect(groups[0].id).not.toBe(groups[1].id);
  });

  it("opens only the selected sequence", () => {
    const messages = [
      message("m1", "", [toolCall({ id: "a", kind: "execute", arguments: { command: "pwd" } })]),
      message("m2", "Some prose"),
      message("m3", "", [toolCall({ id: "b", kind: "execute", arguments: { command: "ls" } })]),
    ];
    const collapsed = projectRows(messages, OPTS).rows.filter(
      (row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup,
    );
    const opened = projectRows(messages, {
      ...OPTS,
      expandedTurns: new Set([OPEN_WORK, collapsed[1].id]),
    }).rows.filter((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    expect(opened.map((group) => group.open)).toEqual([false, true]);
  });

  it("starts collapsed while calls are running", () => {
    const rows = projectRows(
      [
        message("m1", "", [
          toolCall({
            id: "a",
            status: "running",
            kind: "read",
            toolName: "read",
            arguments: { file_path: "/repo/src/turn-rows.ts" },
          }),
        ]),
      ],
      { ...OPTS, streaming: true },
    ).rows;
    const group = rows.find((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    expect(group?.running).toBe(true);
    expect(group?.open).toBe(false);
    expect(group?.liveLabel).toBe("Reading turn-rows.ts");
    expect(group?.summary).toBe("Read a file");
  });

  it("names the file a live edit is writing, and clears the live label when settled", () => {
    const call = toolCall({
      id: "edit",
      status: "running",
      kind: "edit",
      toolName: "write",
      arguments: { file_path: "/repo/src/a.ts", content: "new" },
    });
    const live = projectRows([message("m1", "", [call])], {
      ...OPTS,
      streaming: true,
    }).rows.find((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    expect(live?.liveLabel).toBe("Editing a.ts");
    const settled = projectRows([message("m1", "", [{ ...call, status: "completed" }])], {
      ...OPTS,
      streaming: false,
    }).rows.find((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    expect([settled?.running, settled?.liveLabel, settled?.summary]).toEqual([
      false,
      null,
      "Edited a file",
    ]);
  });

  // The regression this whole live line exists to prevent: "Running command"
  // rendered `bun run build:app` and `ls` as the same sentence, so the one
  // thing on screen during the longest wait in a turn said nothing about it.
  it("names the command a live run is executing", () => {
    const group = projectRows(
      [
        message("m1", "", [
          toolCall({
            id: "a",
            status: "running",
            kind: "execute",
            toolName: "bun run typecheck",
            arguments: { command: "bun run typecheck" },
          }),
        ]),
      ],
      { ...OPTS, streaming: true },
    ).rows.find((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    expect([group?.liveTool, group?.liveLabel]).toEqual(["run", "Running bun run typecheck"]);
  });

  it("names the running call, not a later one still pending", () => {
    const group = projectRows(
      [
        message("m1", "", [
          toolCall({
            id: "a",
            status: "running",
            kind: "execute",
            arguments: { command: "cargo build" },
          }),
          toolCall({
            id: "b",
            status: "pending",
            kind: "execute",
            arguments: { command: "cargo test" },
          }),
        ]),
      ],
      { ...OPTS, streaming: true },
    ).rows.find((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    // Naming `b` would claim cargo test was running before it had started.
    expect(group?.liveLabel).toBe("Running cargo build");
  });

  it("counts finished calls beside the live line and times only the running one", () => {
    const group = projectRows(
      [
        message("m1", "", [
          toolCall({
            id: "a",
            kind: "read",
            toolName: "read",
            arguments: { file_path: "/r/a.ts" },
          }),
          toolCall({ id: "b", status: "failed", kind: "execute", arguments: { command: "ls" } }),
          toolCall({
            id: "c",
            status: "running",
            kind: "execute",
            arguments: { command: "cargo test" },
            startedAt: 1_700_000_000_000,
          }),
          toolCall({ id: "d", status: "pending", kind: "read", toolName: "read" }),
        ]),
      ],
      { ...OPTS, streaming: true },
    ).rows.find((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    // Failed counts as finished; pending does not. The total (4) is deliberately
    // not reported — it only exists because this fixture arrived all at once.
    expect(group?.liveDone).toBe(2);
    expect(group?.liveStartedAt).toBe(1_700_000_000_000);
  });

  it("has no clock to run when the only unfinished call is pending", () => {
    const group = projectRows(
      [
        message("m1", "", [
          toolCall({
            id: "a",
            status: "pending",
            kind: "execute",
            arguments: { command: "cargo test" },
            startedAt: 1_700_000_000_000,
          }),
        ]),
      ],
      { ...OPTS, streaming: true },
    ).rows.find((row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup);
    // The stamp is when the call was ANNOUNCED. Counting from it would put
    // queue time on screen as if the command were working.
    expect([group?.running, group?.liveLabel, group?.liveStartedAt]).toEqual([
      true,
      "Running cargo test",
      null,
    ]);
  });
});

describe("the icon a folded block leads with", () => {
  const message = (id: string, calls: ToolCallDisplay[]): ChatMessage => ({
    ...turn()[0],
    id,
    toolCalls: calls,
  });
  const group = (calls: ToolCallDisplay[], streaming = false) =>
    projectRows([message("m1", calls)], { ...OPTS, streaming }).rows.find(
      (row): row is MarkerGroupRow => row.kind === RowKind.MarkerGroup,
    );

  it("is the first bucket in the sentence, not the commonest", () => {
    const g = group([
      toolCall({ id: "a", kind: "execute", arguments: { command: "cargo test" } }),
      toolCall({ id: "b", kind: "execute", arguments: { command: "cargo build" } }),
      toolCall({ id: "c", kind: "read", toolName: "read", arguments: { file_path: "/r/a.ts" } }),
    ]);
    expect([g?.summary, g?.tool]).toEqual(["Read a file, ran commands", "read"]);
  });

  it("is the running call's own icon while the block is live", () => {
    const g = group(
      [
        toolCall({ id: "a", kind: "execute", arguments: { command: "cargo test" } }),
        toolCall({ id: "b", kind: "execute", status: "running", arguments: { command: "rg foo" } }),
      ],
      true,
    );
    // The block's own icon is the book — a search counts toward "read files",
    // which leads "ran commands" — but the live line wears the magnifier.
    expect([g?.tool, g?.liveTool, g?.liveLabel]).toEqual(["read", "search", "Searching for foo"]);
  });
});

describe("the work header", () => {
  const user = (id: string, timestamp: string): ChatMessage =>
    ({ ...turn()[0], id, role: "user", content: "go", timestamp }) as ChatMessage;
  const said = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    ...turn()[0],
    id,
    content,
    ...extra,
  });
  const ran = (id: string): ChatMessage => ({
    ...turn()[0],
    id,
    toolCalls: [toolCall({ id: `tc-${id}`, kind: "execute", arguments: { command: "pwd" } })],
  });
  const thread = (extra: Partial<ChatMessage> = {}) => [
    user("u1", "2026-08-23T00:00:00Z"),
    said("a1", "Looking."),
    ran("a2"),
    said("a3", "Done — the build passes.", extra),
  ];
  const project = (messages: ChatMessage[], opts: Partial<ProjectOptions> = {}) =>
    projectRows(messages, { ...OPTS, expandedTurns: new Set<string>(), ...opts }).rows;

  it("folds everything before the final answer once the turn settles", () => {
    const rows = project(thread({ workedMs: 457_000 }));
    expect(rows.map((r) => r.kind)).toEqual([RowKind.User, RowKind.WorkHeader, RowKind.Prose]);
    expect(rows[1]).toMatchObject({ foldable: true, open: false, workedMs: 457_000, live: false });
    // The folded first prose row carried the model line; the answer inherits it.
    expect(rows[2]).toMatchObject({ text: "Done — the build passes.", showHeader: true });
  });

  it("puts the work back in the thread when opened", () => {
    const rows = project(thread(), { expandedTurns: new Set(["wk:t:a1"]) });
    expect(rows.map((r) => r.kind)).toEqual([
      RowKind.User,
      RowKind.WorkHeader,
      RowKind.Prose,
      RowKind.MarkerGroup,
      RowKind.Prose,
    ]);
    expect(rows[1]).toMatchObject({ open: true });
  });

  it("folds nothing and counts from the user's message while the turn is live", () => {
    const rows = project(thread(), { streaming: true });
    const header = rows[1] as WorkHeaderRow;
    expect(rows).toHaveLength(5);
    expect([header.live, header.foldable, header.startedAt]).toEqual([
      true,
      false,
      Date.parse("2026-08-23T00:00:00Z"),
    ]);
  });

  it("stays open and live while the turn is paused on a permission prompt", () => {
    // `streaming` is false while the agent waits on the user; the turn is not over.
    const rows = project(thread(), { streaming: false, turnInProgress: true });
    expect(rows).toHaveLength(5);
    expect(rows[1]).toMatchObject({ kind: RowKind.WorkHeader, live: true, foldable: false });
  });

  it("has no time to show for a turn that was not timed live", () => {
    expect(project(thread())[1]).toMatchObject({ workedMs: null, foldable: true });
  });

  it("is a plain caption on a prose-only turn, and absent when that turn was not timed", () => {
    const timed = project([
      user("u1", "2026-08-23T00:00:00Z"),
      said("a1", "Hi.", { workedMs: 3000 }),
    ]);
    expect(timed[1]).toMatchObject({ kind: RowKind.WorkHeader, foldable: false });
    const untimed = project([user("u1", "2026-08-23T00:00:00Z"), said("a1", "Hi.")]);
    expect(untimed.map((r) => r.kind)).toEqual([RowKind.User, RowKind.Prose]);
  });
});
