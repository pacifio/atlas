import { describe, expect, it } from "vitest";
import {
  collectTurnEdits,
  editsSignature,
  listEditTurns,
  PROMPT_SNIPPET_CHARS,
} from "./turn-edits";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

const REPO = "/repo";

function toolCall(tc: Partial<ToolCallDisplay>): ToolCallDisplay {
  return {
    id: "tc",
    toolName: "apply_patch",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    contentBlocks: [],
    ...tc,
  } as ToolCallDisplay;
}

/** One assistant turn, `t:m1`, made of the given tool calls. */
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

function diffBlock(path: string, oldText: string | undefined, newText: string) {
  return oldText === undefined
    ? { type: "diff" as const, path, newText }
    : { type: "diff" as const, path, oldText, newText };
}

describe("edits reported as ACP diff blocks", () => {
  it("carries the block's before and after text", () => {
    const edits = collectTurnEdits(
      turn(toolCall({ contentBlocks: [diffBlock("/repo/a.ts", "before\n", "after\n")] })),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["a.ts"]);
    expect(edits.sources["a.ts"]).toEqual({ old: "before\n", new: "after\n" });
  });

  it("folds repeat edits to one file as first-before against last-after", () => {
    // The bug this pins: `acp::Diff` carries the WHOLE file either side, not
    // the replaced fragment. Concatenating two of them gave `old = v0 + v1`
    // against `new = v1 + v2` — a diff of the file against a doubled copy of
    // itself, which rendered as every line changed.
    const edits = collectTurnEdits(
      turn(
        toolCall({ id: "tc1", contentBlocks: [diffBlock("/repo/a.ts", "v0\n", "v1\n")] }),
        toolCall({ id: "tc2", contentBlocks: [diffBlock("/repo/a.ts", "v1\n", "v2\n")] }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["a.ts"]);
    expect(edits.sources["a.ts"]).toEqual({ old: "v0\n", new: "v2\n" });
  });

  it("treats an absent before-text as a created file", () => {
    const edits = collectTurnEdits(
      turn(toolCall({ contentBlocks: [diffBlock("/repo/new.ts", undefined, "hello\n")] })),
      "t:m1",
      REPO,
    );
    expect(edits.sources["new.ts"]).toEqual({ old: "", new: "hello\n" });
  });

  it("keeps several files apart, in the order the turn touched them", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          contentBlocks: [
            diffBlock("/repo/b.ts", "b0\n", "b1\n"),
            diffBlock("/repo/a.ts", "a0\n", "a1\n"),
          ],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["b.ts", "a.ts"]);
    expect(edits.sources["a.ts"].new).toBe("a1\n");
    expect(edits.sources["b.ts"].new).toBe("b1\n");
  });
});

describe("edits reported as tool arguments", () => {
  it("still concatenates fragments, which is what Edit arguments carry", () => {
    // Unlike a diff block, an `Edit` names only the text it replaced, so two
    // edits to one file legitimately add up to one fragment pair.
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "tc1",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
        }),
        toolCall({
          id: "tc2",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "two\n", new_string: "TWO\n" },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["a.ts"]).toEqual({ old: "one\ntwo\n", new: "ONE\nTWO\n" });
  });

  it("prefers the whole file when the same path came both ways", () => {
    // A fragment pair cannot improve on the complete file.
    const edits = collectTurnEdits(
      turn(
        toolCall({
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
          contentBlocks: [diffBlock("/repo/a.ts", "one\ntwo\n", "ONE\ntwo\n")],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["a.ts"]).toEqual({ old: "one\ntwo\n", new: "ONE\ntwo\n" });
  });
});

describe("which file the viewer lands on", () => {
  const messages = turn(
    toolCall({
      contentBlocks: [
        diffBlock("/repo/b.ts", "b0\n", "b1\n"),
        diffBlock("/repo/a.ts", "a0\n", "a1\n"),
      ],
    }),
  );

  it("is the requested one when the turn touched it", () => {
    expect(collectTurnEdits(messages, "t:m1", REPO, "/repo/a.ts").initial).toBe("a.ts");
  });

  it("falls back to the first file when the requested one is not in the turn", () => {
    expect(collectTurnEdits(messages, "t:m1", REPO, "/repo/z.ts").initial).toBe("b.ts");
  });

  it("is empty for a turn that changed nothing", () => {
    const none = collectTurnEdits(turn(toolCall({ toolName: "Read" })), "t:m1", REPO);
    expect(none).toEqual({ files: [], initial: "", sources: {}, excerpts: new Set() });
  });
});

describe("which files are only excerpts", () => {
  it("marks a file the turn knew only by the fragments it replaced", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect([...edits.excerpts]).toEqual(["a.ts"]);
  });

  it("does not mark a whole file written out, or one a diff block carried", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "w",
          toolName: "Write",
          arguments: { file_path: "/repo/new.ts", content: "x\n" },
        }),
        toolCall({
          id: "e",
          toolName: "Edit",
          arguments: { file_path: "/repo/b.ts", old_string: "b\n", new_string: "B\n" },
          contentBlocks: [diffBlock("/repo/b.ts", "a\nb\n", "a\nB\n")],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["new.ts", "b.ts"]);
    expect(edits.excerpts.size).toBe(0);
  });
});

function message(id: string, role: "user" | "assistant", extra: Partial<ChatMessage> = {}) {
  return {
    id,
    role,
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: `2026-08-23T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`,
    mode: "text",
    ...extra,
  } as ChatMessage;
}

const edit = (path: string, id = path) =>
  toolCall({
    id,
    toolName: "Edit",
    arguments: { file_path: `/repo/${path}`, old_string: "a", new_string: "b" },
  });

describe("listEditTurns", () => {
  const messages = [
    message("u1", "user", { content: "Fix the login form" }),
    message("a2", "assistant", { toolCalls: [edit("src/login.tsx"), edit("src/login.tsx", "x")] }),
    message("a3", "assistant", { toolCalls: [edit("src/auth.ts")] }),
    message("u4", "user", { content: "Where is the cookie set?" }),
    message("a5", "assistant", { toolCalls: [toolCall({ id: "r5", toolName: "Read" })] }),
    message("u6", "user", {
      content: "Long prompt\n\nwith context",
      atlasProse: `Add a users route ${"and more words ".repeat(10)}`,
    }),
    message("a7", "assistant", {
      toolCalls: [toolCall({ id: "d7", contentBlocks: [diffBlock("/repo/routes.ts", "a", "b")] })],
    }),
  ];

  it("lists the turns that changed files, newest first, numbered among all turns", () => {
    const turns = listEditTurns(messages, REPO);
    expect(turns.map((t) => [t.turnId, t.number, t.fileCount])).toEqual([
      ["tc:d7", 3, 1],
      ["tc:src/login.tsx", 1, 2],
    ]);
  });

  it("stamps each with when it finished and the prompt it answered, on one line", () => {
    const [latest, first] = listEditTurns(messages, REPO);
    expect(first.timestamp).toBe(messages[2].timestamp);
    expect(first.prompt).toBe("Fix the login form");
    // The prose without its @-mention context, cut to the snippet length.
    expect(latest.prompt.startsWith("Add a users route and more words")).toBe(true);
    expect(latest.prompt.length).toBe(PROMPT_SNIPPET_CHARS);
    expect(latest.prompt.endsWith("…")).toBe(true);
  });

  it("uses the same turn ids collectTurnEdits reads", () => {
    for (const t of listEditTurns(messages, REPO)) {
      expect(collectTurnEdits(messages, t.turnId, REPO).files.length).toBe(t.fileCount);
    }
  });
});

describe("a turn's name", () => {
  // The transcript names a run by its first NON-empty message; an engine
  // that opens a turn with a bare "\n\n" chunk puts an empty one first.
  const messages = [
    message("u0", "user", { content: "Go" }),
    message("a1", "assistant", { content: "\n\n" }),
    message("a2", "assistant", { toolCalls: [edit("src/a.ts", "e2")] }),
  ];

  it("resolves from any message of the run, so the card and the picker agree", () => {
    const [listed] = listEditTurns(messages, REPO);
    expect(listed.turnId).toBe("tc:e2");
    for (const ref of ["t:a1", "t:a2", "tc:e2"]) {
      expect(collectTurnEdits(messages, ref, REPO).files).toEqual(["src/a.ts"]);
    }
  });

  it("does not count a run of nothing but empty messages as a turn", () => {
    const withBlank = [
      message("u0", "user"),
      message("a1", "assistant", { content: " " }),
      ...messages,
    ];
    expect(listEditTurns(withBlank, REPO)[0].number).toBe(1);
  });
});

describe("editsSignature", () => {
  it("ignores streamed prose and changes when a call arrives or settles", () => {
    const base = [message("u1", "user"), message("a2", "assistant", { content: "Hel" })];
    const sig = editsSignature(base);
    const streamed = [base[0], { ...base[1], content: "Hello there" }];
    expect(editsSignature(streamed)).toBe(sig);
    const called = [base[0], { ...base[1], toolCalls: [edit("a.ts")] }];
    expect(editsSignature(called)).not.toBe(sig);
    const settled = [
      base[0],
      { ...base[1], toolCalls: [{ ...edit("a.ts"), status: "failed" as const }] },
    ];
    expect(editsSignature(settled)).not.toBe(editsSignature(called));
    expect(editsSignature([...base, message("u3", "user")])).not.toBe(sig);
  });

  it("moves with the store's tool revision, whichever message a call is in", () => {
    const base = [message("u1", "user"), message("a2", "assistant", { content: "Hi" })];
    expect(editsSignature(base, 4)).not.toBe(editsSignature(base, 3));
  });
});

/** The native engine's edit: `{ paths, patch }`, each file's text joined. */
const engineEdit = (id: string, files: [string, string][]) =>
  toolCall({
    id,
    toolName: `Edit /repo/${files[0][0]}`,
    kind: "edit",
    arguments: {
      paths: files.map(([path]) => `/repo/${path}`),
      patch: files.map(([, text]) => text).join("\n"),
    },
  });

describe("edits the native engine reported", () => {
  const hunks = "@@ -2,2 +2,3 @@\n a\n+b\n c\n";

  it("keeps a file's one diff as it is: real line numbers, not an excerpt", () => {
    const edits = collectTurnEdits(turn(engineEdit("n1", [["src/x.rs", hunks]])), "t:m1", REPO);
    expect(edits.files).toEqual(["src/x.rs"]);
    expect(edits.sources["src/x.rs"]).toEqual({ old: "a\nc\n", new: "a\nb\nc\n", patch: hunks });
    expect(edits.excerpts.size).toBe(0);
  });

  it("splits a patch naming several files, created ones whole", () => {
    const edits = collectTurnEdits(
      turn(
        engineEdit("n1", [
          ["src/a.rs", hunks],
          ["src/new.rs", "fn main() {}\n"],
        ]),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["src/a.rs", "src/new.rs"]);
    expect(edits.sources["src/new.rs"]).toEqual({ old: "", new: "fn main() {}\n" });
  });

  it("folds two diffs to one file into an excerpt", () => {
    const edits = collectTurnEdits(
      turn(engineEdit("n1", [["src/x.rs", hunks]]), engineEdit("n2", [["src/x.rs", hunks]])),
      "t:m1",
      REPO,
    );
    expect(edits.sources["src/x.rs"].patch).toBeUndefined();
    expect([...edits.excerpts]).toEqual(["src/x.rs"]);
  });

  it("lists the turn, and names it by the call", () => {
    const messages = [message("u0", "user"), ...turn(engineEdit("n1", [["src/x.rs", hunks]]))];
    expect(listEditTurns(messages, REPO).map((t) => [t.turnId, t.fileCount])).toEqual([
      ["tc:n1", 1],
    ]);
  });
});

describe("edits the native engine reported with per-file `changes`", () => {
  const edits = collectTurnEdits(
    turn(
      toolCall({
        id: "n1",
        toolName: "Edit /repo/src/a.rs (+1 more)",
        kind: "edit",
        arguments: {
          paths: ["/repo/src/a.rs", "/repo/src/b.rs"],
          // Two whole contents side by side: unsplittable from `patch`.
          patch: "fn a() {}\n\nfn b() {}\n",
          changes: [
            { path: "/repo/src/a.rs", kind: "add", lines: [0, 2] },
            { path: "/repo/src/b.rs", kind: "delete", lines: [2, 4] },
          ],
        },
      }),
    ),
    "t:m1",
    REPO,
  );

  it("keeps created and deleted files apart, each whole", () => {
    expect(edits.files).toEqual(["src/a.rs", "src/b.rs"]);
    expect(edits.sources["src/a.rs"]).toEqual({ old: "", new: "fn a() {}\n" });
    // Its old text against nothing, named a delete outright.
    expect(edits.sources["src/b.rs"]).toEqual({ old: "fn b() {}\n", new: "", deleted: true });
    expect(edits.excerpts.size).toBe(0);
    expect(edits.renames).toBeUndefined();
  });

  it("files a renamed file under where it went, and remembers where it was", () => {
    const hunks = "@@ -1 +1 @@\n-c\n+d\n";
    const renamed = collectTurnEdits(
      turn(
        toolCall({
          id: "n2",
          toolName: "Edit /repo/src/c.rs",
          kind: "edit",
          arguments: {
            paths: ["/repo/src/c.rs"],
            patch: `${hunks}\n\nMoved to: /repo/src/d.rs`,
            changes: [
              { path: "/repo/src/c.rs", kind: "rename", lines: [0, 4], movePath: "/repo/src/d.rs" },
            ],
          },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(renamed.files).toEqual(["src/d.rs"]);
    expect(renamed.sources["src/d.rs"].patch).toBe(hunks);
    expect(renamed.renames).toEqual({ "src/d.rs": "src/c.rs" });
  });
});

/** An engine edit that moves `from` to `to`, with `hunks` as its diff. */
const engineRename = (id: string, from: string, to: string, hunks: string) =>
  toolCall({
    id,
    toolName: `Edit /repo/${from}`,
    kind: "edit",
    arguments: {
      paths: [`/repo/${from}`],
      patch: `${hunks}\n\nMoved to: /repo/${to}`,
      changes: [
        {
          path: `/repo/${from}`,
          kind: "rename",
          lines: [0, hunks === "" ? 0 : hunks.split("\n").length],
          movePath: `/repo/${to}`,
        },
      ],
    },
  });

describe("a file the engine renamed", () => {
  const hunks = "@@ -1 +1 @@\n-c\n+d\n";

  it("opens where it went when asked for by where it was", () => {
    const edits = collectTurnEdits(
      turn(engineRename("n1", "src/c.rs", "src/d.rs", hunks)),
      "t:m1",
      REPO,
      "/repo/src/c.rs",
    );
    expect(edits.initial).toBe("src/d.rs");
  });

  it("is one file when edited, then renamed, in the same turn", () => {
    const messages = [
      message("u0", "user"),
      ...turn(
        engineEdit("n1", [["src/c.rs", "@@ -1 +1 @@\n-a\n+c\n"]]),
        engineRename("n2", "src/c.rs", "src/d.rs", hunks),
      ),
    ];
    const edits = collectTurnEdits(messages, "tc:n1", REPO);
    expect(edits.files).toEqual(["src/d.rs"]);
    expect(edits.renames).toEqual({ "src/d.rs": "src/c.rs" });
    expect(listEditTurns(messages, REPO).map((t) => t.fileCount)).toEqual([1]);
  });

  it("has an empty diff when it was moved and not edited", () => {
    const edits = collectTurnEdits(
      turn(engineRename("n1", "src/c.rs", "src/d.rs", "")),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["src/d.rs"]);
    expect(edits.sources["src/d.rs"]).toEqual({ old: "", new: "", patch: "" });
    expect(edits.renames).toEqual({ "src/d.rs": "src/c.rs" });
  });
});

describe("a file the engine deleted", () => {
  it("is named deleted even when it was empty", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "n1",
          toolName: "Edit /repo/src/empty.rs",
          kind: "edit",
          arguments: {
            paths: ["/repo/src/empty.rs"],
            patch: "",
            changes: [{ path: "/repo/src/empty.rs", kind: "delete", lines: [0, 0] }],
          },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["src/empty.rs"]).toEqual({ old: "", new: "", deleted: true });
  });
});

describe("a Write, then Edits to the file it wrote", () => {
  it("applies each fragment to the written text: the file the turn left", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "w",
          toolName: "Write",
          arguments: { file_path: "/repo/a.ts", content: "one\ntwo\n" },
        }),
        toolCall({
          id: "e",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "two", new_string: "$& TWO" },
        }),
      ),
      "t:m1",
      REPO,
    );
    // `$&` is text, not a replacement pattern.
    expect(edits.sources["a.ts"]).toEqual({ old: "", new: "one\n$& TWO\n" });
    expect(edits.excerpts.size).toBe(0);
  });

  it("falls back to the excerpt when a fragment is not in the written text", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "w",
          toolName: "Write",
          arguments: { file_path: "/repo/a.ts", content: "one\n" },
        }),
        toolCall({
          id: "e",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "zzz", new_string: "Z" },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["a.ts"]).toEqual({ old: "zzz", new: "one\nZ" });
    expect([...edits.excerpts]).toEqual(["a.ts"]);
  });

  it("applies the engine's hunks to a file the turn created", () => {
    const edits = collectTurnEdits(
      turn(
        engineEdit("n1", [["src/x.rs", "a\nc\n"]]),
        engineEdit("n2", [["src/x.rs", "@@ -1,2 +1,3 @@\n a\n+b\n c\n"]]),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["src/x.rs"]).toEqual({ old: "", new: "a\nb\nc\n" });
  });
});
