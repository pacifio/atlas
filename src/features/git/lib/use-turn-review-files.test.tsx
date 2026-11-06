// @vitest-environment happy-dom
//
// The review panel's turn scope: the turn picker's list, one turn's files as
// review rows, and the keys that keep a settled turn from re-diffing.

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const diffTextsPatch = vi.fn();
vi.mock("./git-review-api", () => ({
  diffTextsPatch: (...a: unknown[]) => diffTextsPatch(...a),
}));

import type { ChatMessage, ChatSession, ToolCallDisplay } from "@/types/agent";
import { useChatStore } from "@/features/chat/stores/chat-store";
import type { TurnEdits } from "@/features/chat/lib/turn-edits";
import {
  statusOfSource,
  useSessionEditTurns,
  useTurnEdits,
  useTurnReviewFiles,
} from "./use-turn-review-files";

const REPO = "/repo";
const ACP = "acp-1";

function call(id: string, path: string, oldString: string, newString: string): ToolCallDisplay {
  return {
    id,
    toolName: "Edit",
    kind: "edit",
    status: "completed",
    arguments: { file_path: `${REPO}/${path}`, old_string: oldString, new_string: newString },
    result: null,
    duration: null,
    locations: [],
  } as ToolCallDisplay;
}

function message(id: string, role: "user" | "assistant", extra: Partial<ChatMessage> = {}) {
  return {
    id,
    role,
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-01T09:00:00Z",
    mode: "text",
    ...extra,
  } as ChatMessage;
}

function seed(messages: ChatMessage[]) {
  useChatStore.setState((s) => ({
    ...s,
    sessions: {
      "tab-1": { id: "tab-1", acpSessionId: ACP, messages } as unknown as ChatSession,
    },
  }));
}

const patchOf = (path: string, minus: string, plus: string) =>
  `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${minus}\n+${plus}\n`;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  diffTextsPatch.mockReset();
  diffTextsPatch.mockImplementation(async (_old: string, _new: string, file: string) => ({
    patch: patchOf(file, "a", "b"),
    truncated: false,
    binary: false,
  }));
  seed([
    message("u1", "user", { content: "Fix the login form" }),
    message("a2", "assistant", { toolCalls: [call("c1", "src/login.tsx", "a\n", "b\n")] }),
    message("u3", "user", { content: "And the session" }),
    message("a4", "assistant", { toolCalls: [call("c2", "src/session.ts", "x\n", "y\n")] }),
  ]);
});

describe("useSessionEditTurns", () => {
  it("lists the session's turns that changed files, newest first", () => {
    const { result } = renderHook(() => useSessionEditTurns(ACP, REPO));
    expect(result.current.map((t) => [t.turnId, t.number, t.prompt])).toEqual([
      // Stable keys: the first edit's call id, which a reload keeps.
      ["tc:c2", 2, "And the session"],
      ["tc:c1", 1, "Fix the login form"],
    ]);
  });

  it("keeps its answer while only prose streams, and updates when a turn edits", () => {
    const { result } = renderHook(() => useSessionEditTurns(ACP, REPO));
    const first = result.current;
    const messages = useChatStore.getState().sessions["tab-1"].messages;
    act(() => seed([...messages.slice(0, 3), { ...messages[3], content: "Done, and more" }]));
    expect(result.current).toBe(first);
    act(() =>
      seed([
        ...messages,
        message("u5", "user", { content: "One more" }),
        message("a6", "assistant", { toolCalls: [call("c3", "README.md", "r\n", "R\n")] }),
      ]),
    );
    expect(result.current[0].turnId).toBe("tc:c3");
  });

  it("hears a tool call change in an earlier message of the live turn", () => {
    const { result } = renderHook(() => useSessionEditTurns(ACP, REPO));
    expect(result.current[0].turnId).toBe("tc:c2");
    const messages = useChatStore.getState().sessions["tab-1"].messages;
    // The turn's edit lands in a4, then prose follows in a5. A later upsert
    // that adds a file to a4's call changes nothing about the LAST message:
    // only the store's tool revision says the edits moved.
    const grown = message("a4", "assistant", {
      toolCalls: [
        call("c2", "src/session.ts", "x\n", "y\n"),
        call("c9", "src/cookie.ts", "p\n", "q\n"),
      ],
    });
    act(() => seed([...messages.slice(0, 3), messages[3], message("a5", "assistant")]));
    const before = result.current;
    act(() =>
      useChatStore.setState((s) => ({
        ...s,
        sessions: {
          "tab-1": {
            ...s.sessions["tab-1"],
            messages: [...messages.slice(0, 3), grown, message("a5", "assistant")],
            toolRevision: 1,
          } as ChatSession,
        },
      })),
    );
    expect(result.current).not.toBe(before);
    expect(result.current[0].fileCount).toBe(2);
  });

  it("walks nothing while disabled", () => {
    const { result } = renderHook(() => useSessionEditTurns(ACP, REPO, false));
    expect(result.current).toEqual([]);
  });

  it("is empty for a session the chat store does not hold", () => {
    const { result } = renderHook(() => useSessionEditTurns("nope", REPO));
    expect(result.current).toEqual([]);
  });
});

describe("useTurnEdits", () => {
  it("keeps each unchanged text pair's object across a re-read", () => {
    const { result } = renderHook(() => useTurnEdits(ACP, "tc:c1", REPO));
    const pair = result.current!.sources["src/login.tsx"];
    const messages = useChatStore.getState().sessions["tab-1"].messages;
    // A later message arrives: the signature moves and the turn is re-read.
    act(() => seed([...messages, message("u5", "user")]));
    expect(result.current!.sources["src/login.tsx"]).toBe(pair);
  });
});

describe("useTurnReviewFiles", () => {
  const edits = (): TurnEdits => ({
    files: ["src/a.ts", "src/b.ts"],
    initial: "src/a.ts",
    sources: {
      "src/a.ts": { old: "one\ntwo\n", new: "one\nTWO\nthree\n" },
      "src/b.ts": { old: "", new: "created\n" },
    },
    excerpts: new Set(["src/a.ts"]),
  });

  it("lists every file at once, counted from its texts until its patch is parsed", async () => {
    let resolve: () => void = () => {};
    diffTextsPatch.mockImplementation(
      (_o: string, _n: string, file: string) =>
        new Promise((r) => {
          resolve = () => r({ patch: patchOf(file, "a", "b"), truncated: false, binary: false });
        }),
    );
    const input = edits();
    const { result } = renderHook(
      () => useTurnReviewFiles({ edits: input, ignoreWhitespace: false }),
      { wrapper: wrapper() },
    );
    const [a, b] = result.current.files;
    expect(a.state).toBe("pending");
    expect(a.stat).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
    });
    expect(a.excerpt).toBe(true);
    expect(b.stat).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(b.excerpt).toBe(false);
    act(() => resolve());
    await waitFor(() => expect(result.current.files.some((f) => f.state === "ready")).toBe(true));
  });

  it("parses each patch under its repo path, typed by what the texts say", async () => {
    const input = edits();
    const { result } = renderHook(
      () => useTurnReviewFiles({ edits: input, ignoreWhitespace: false }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.files.every((f) => f.state === "ready")).toBe(true));
    const [a, b] = result.current.files;
    expect(a.fileDiff.name).toBe("src/a.ts");
    expect(a.stat).toMatchObject({ additions: 1, deletions: 1 });
    expect(b.fileDiff.type).toBe("new");
  });

  it("does not diff a pair again when the same texts come back in a new turn read", async () => {
    const first = edits();
    const { result, rerender } = renderHook(
      ({ e }) => useTurnReviewFiles({ edits: e, ignoreWhitespace: false }),
      { wrapper: wrapper(), initialProps: { e: first } },
    );
    await waitFor(() => expect(result.current.files.every((f) => f.state === "ready")).toBe(true));
    expect(diffTextsPatch).toHaveBeenCalledTimes(2);
    // Same texts, fresh objects: the key is the texts' fingerprint, not the object.
    rerender({ e: edits() });
    await waitFor(() => expect(result.current.files.every((f) => f.state === "ready")).toBe(true));
    expect(diffTextsPatch).toHaveBeenCalledTimes(2);
    // A changed text is a new key.
    const changed = edits();
    changed.sources["src/a.ts"] = { old: "one\n", new: "uno\n" };
    rerender({ e: changed });
    await waitFor(() => expect(diffTextsPatch).toHaveBeenCalledTimes(3));
  });

  it("renders the native engine's own diff as it is, with no round trip", async () => {
    const input: TurnEdits = {
      files: ["src/login.rs"],
      initial: "src/login.rs",
      sources: {
        "src/login.rs": {
          old: "use a;\n",
          new: "use a;\nuse b;\n",
          patch: "@@ -10,1 +10,2 @@\n use a;\n+use b;\n",
        },
      },
      excerpts: new Set(),
    };
    const { result } = renderHook(
      () => useTurnReviewFiles({ edits: input, ignoreWhitespace: false }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.files[0].state).toBe("ready"));
    const [file] = result.current.files;
    expect(diffTextsPatch).not.toHaveBeenCalled();
    expect(file.stat).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(file.excerpt).toBe(false);
    // The engine's line numbers, not the excerpt's.
    expect(file.fileDiff.hunks[0].additionStart).toBe(10);
  });

  it("shows a renamed file under its new path, with the old one beside it", async () => {
    const input: TurnEdits = {
      files: ["src/d.rs"],
      initial: "src/d.rs",
      sources: { "src/d.rs": { old: "c\n", new: "d\n", patch: "@@ -1 +1 @@\n-c\n+d\n" } },
      excerpts: new Set(),
      renames: { "src/d.rs": "src/c.rs" },
    };
    const { result } = renderHook(
      () => useTurnReviewFiles({ edits: input, ignoreWhitespace: false }),
      { wrapper: wrapper() },
    );
    expect(result.current.files[0].fileDiff.prevName).toBe("src/c.rs");
    await waitFor(() => expect(result.current.files[0].state).toBe("ready"));
    const [file] = result.current.files;
    expect(file.stat).toMatchObject({ path: "src/d.rs", oldPath: "src/c.rs", status: "renamed" });
    expect(file.fileDiff).toMatchObject({
      name: "src/d.rs",
      prevName: "src/c.rs",
      type: "rename-changed",
    });
  });

  it("shows a file moved and not edited as renamed, with nothing under it", async () => {
    const input: TurnEdits = {
      files: ["src/d.rs"],
      initial: "src/d.rs",
      sources: { "src/d.rs": { old: "", new: "", patch: "" } },
      excerpts: new Set(),
      renames: { "src/d.rs": "src/c.rs" },
    };
    const { result } = renderHook(
      () => useTurnReviewFiles({ edits: input, ignoreWhitespace: false }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.files[0].state).toBe("empty"));
    const [file] = result.current.files;
    expect(diffTextsPatch).not.toHaveBeenCalled();
    expect(file.stat).toMatchObject({ status: "renamed", oldPath: "src/c.rs", additions: 0 });
    expect(file.fileDiff).toMatchObject({ prevName: "src/c.rs", type: "rename-changed" });
  });

  it("calls an emptied fragment a modification, never a deleted file", () => {
    expect(statusOfSource({ old: "block\n", new: "" }, true)).toBe("modified");
    expect(statusOfSource({ old: "file\n", new: "" }, false)).toBe("deleted");
    expect(statusOfSource({ old: "", new: "file\n" }, false)).toBe("added");
  });

  it("calls a file the turn deleted deleted, even one that was empty", () => {
    expect(statusOfSource({ old: "", new: "", deleted: true }, false)).toBe("deleted");
    expect(statusOfSource({ old: "", new: "" }, false)).toBe("modified");
  });

  it("reports a failed diff as an error the row can retry", async () => {
    diffTextsPatch.mockRejectedValueOnce(new Error("boom"));
    const input = edits();
    const { result } = renderHook(
      () => useTurnReviewFiles({ edits: input, ignoreWhitespace: false }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.files[0].state).toBe("error"));
    act(() => result.current.retry("src/a.ts"));
    await waitFor(() => expect(result.current.files[0].state).toBe("ready"));
  });
});
