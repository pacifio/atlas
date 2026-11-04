// The Memory panel's record keeps up on its own: every write to shared
// memory emits `atlas:memory-changed`, and the store re-pulls the events,
// entries and review queue when it hears one. A record or queue that can't
// be read says so; it never reads as empty.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return () =>
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((h) => h !== handler),
      );
  }),
}));

import { EMPTY_REVIEW, useSharedMemoryStore } from "./shared-memory-store";

const entry = (id: number, content: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "decision",
  key: "auth.alg",
  content,
  status: "",
  source: "extractor",
  agent: "codex",
  sessionId: "s1",
  confidence: 0.6,
  createdAt: 1,
  updatedAt: 2,
  lastUsedAt: null,
  uses: 0,
  revision: 1,
  state: "active",
  ...over,
});

let entries: ReturnType<typeof entry>[] = [];
let candidates: ReturnType<typeof entry>[] = [];
/** Commands that throw, by name. */
let failing = new Set<string>();

function fire(name: string, payload: unknown) {
  for (const handler of listeners.get(name) ?? []) handler({ payload });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const store = () => useSharedMemoryStore.getState();

beforeEach(() => {
  entries = [entry(7, "Use HS256")];
  candidates = [];
  failing = new Set();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (failing.has(cmd)) throw new Error("database is locked");
    switch (cmd) {
      case "memory_list_events":
        return [];
      case "memory_list_entries":
        return entries;
      case "memory_review":
        return { candidates, merges: [], conflicts: [], dreams: [] };
      case "memory_edit_entry": {
        const edited = entry(args.id as number, args.content as string, {
          source: "user",
          agent: "user",
          confidence: 1,
        });
        entries = entries.map((e) => (e.id === args.id ? edited : e));
        return edited;
      }
      case "memory_forget_entry":
        entries = entries.filter((e) => e.id !== args.id);
        return true;
      case "memory_feedback_entry": {
        const marked = { ...entries.find((e) => e.id === args.id)!, state: "archived" };
        entries = entries.map((e) => (e.id === args.id ? marked : e));
        return marked;
      }
      case "memory_promote":
        candidates = [];
        return true;
      default:
        return null;
    }
  });
  useSharedMemoryStore.setState({
    projectPath: null,
    loaded: false,
    entries: [],
    events: [],
    error: null,
    review: EMPTY_REVIEW,
    reviewError: null,
  });
});

describe("keeping up with the record", () => {
  it("re-pulls when shared memory changes", async () => {
    await store().actions.load("/repo");
    expect(store().entries.map((e) => e.content)).toEqual(["Use HS256"]);

    entries = [entry(8, "Use RS256"), ...entries];
    fire("atlas:memory-changed", { root: "/repo", kinds: ["decision"] });
    await flush();

    expect(store().entries.map((e) => e.content)).toEqual(["Use RS256", "Use HS256"]);
  });

  it("re-pulls the project it is showing now, once per change", async () => {
    await store().actions.load("/repo-a");
    await store().actions.load("/repo-b");

    invoke.mockClear();
    fire("atlas:memory-changed", { root: "/repo-b", kinds: ["decision"] });
    await flush();

    const pulled = invoke.mock.calls.filter(([cmd]) => cmd === "memory_list_entries");
    expect(pulled).toEqual([["memory_list_entries", { projectPath: "/repo-b" }]]);
  });

  it("never shows one project's record under another", async () => {
    candidates = [entry(3, "maybe", { state: "candidate" })];
    await store().actions.load("/repo-a");
    expect(store().review.candidates).toHaveLength(1);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      await gate;
      return base(cmd, args);
    });
    const loading = store().actions.load("/repo-b");
    // While B is read, A's record and queue are already gone.
    expect(store()).toMatchObject({ projectPath: "/repo-b", loaded: false, entries: [] });
    expect(store().review).toEqual(EMPTY_REVIEW);
    release();
    await loading;
  });

  it("keeps what it shows while the same project is read again", async () => {
    await store().actions.load("/repo");
    const loading = store().actions.load("/repo");
    expect(store()).toMatchObject({ loaded: true, entries: [expect.objectContaining({ id: 7 })] });
    await loading;
  });
});

describe("a record that can't be read", () => {
  it("says why when the entries can't be read, rather than showing none", async () => {
    failing.add("memory_list_entries");
    await store().actions.load("/repo");
    expect(store()).toMatchObject({ loaded: true, error: "database is locked", entries: [] });
  });

  it("still shows a review queue that can be read", async () => {
    failing.add("memory_list_events");
    candidates = [entry(3, "maybe", { state: "candidate" })];
    await store().actions.load("/repo");
    expect(store().error).toBe("database is locked");
    expect(store().review.candidates).toHaveLength(1);
    expect(store().reviewError).toBeNull();
  });

  it("says why when the review queue can't be read, rather than showing it empty", async () => {
    failing.add("memory_review");
    await store().actions.load("/repo");
    expect(store()).toMatchObject({ error: null, reviewError: "database is locked" });
  });

  it("clears the error once a refresh reads it", async () => {
    failing.add("memory_list_entries");
    await store().actions.load("/repo");
    failing.clear();
    await store().actions.refresh();
    expect(store()).toMatchObject({ error: null, entries: [expect.objectContaining({ id: 7 })] });
  });

  it("keeps the last good record when a refresh fails", async () => {
    await store().actions.load("/repo");
    failing.add("memory_list_entries");
    await store().actions.refresh();
    expect(store()).toMatchObject({ error: null, entries: [expect.objectContaining({ id: 7 })] });
  });
});

describe("changing a memory", () => {
  it("loads every entry with its provenance and confidence", async () => {
    await store().actions.load("/repo");
    const [e] = store().entries;
    expect([e.source, e.agent, e.confidence]).toEqual(["extractor", "codex", 0.6]);
  });

  it("edits an entry as the user", async () => {
    await store().actions.load("/repo");
    await store().actions.editEntry(7, "Use RS256");
    expect(invoke).toHaveBeenCalledWith("memory_edit_entry", {
      projectPath: "/repo",
      id: 7,
      content: "Use RS256",
    });
    const [e] = store().entries;
    expect([e.content, e.source, e.confidence]).toEqual(["Use RS256", "user", 1]);
  });

  it("forgets an entry and re-reads the record", async () => {
    await store().actions.load("/repo");
    invoke.mockClear();
    await store().actions.forgetEntry(7);
    expect(invoke).toHaveBeenCalledWith("memory_forget_entry", { projectPath: "/repo", id: 7 });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "memory_list_entries")).toBe(true);
    expect(store().entries).toEqual([]);
  });

  it("records a verdict and shows its effect at once", async () => {
    await store().actions.load("/repo");
    await store().actions.feedback(7, "wrong");
    expect(invoke).toHaveBeenCalledWith("memory_feedback_entry", {
      projectPath: "/repo",
      id: 7,
      verdict: "wrong",
    });
    expect(store().entries[0].state).toBe("archived");
  });

  it("throws a failed verdict to the caller", async () => {
    await store().actions.load("/repo");
    failing.add("memory_feedback_entry");
    await expect(store().actions.feedback(7, "stale")).rejects.toThrow("database is locked");
  });
});

describe("a review action", () => {
  it("runs against the bound project, answers what the backend said, and re-reads the queue", async () => {
    candidates = [entry(3, "maybe", { state: "candidate" })];
    await store().actions.load("/repo");
    const answer = await store().actions.reviewAction(async (pp) => {
      await invoke("memory_promote", { projectPath: pp, id: 3 });
      return "accepted";
    });
    expect(answer).toBe("accepted");
    expect(invoke).toHaveBeenCalledWith("memory_promote", { projectPath: "/repo", id: 3 });
    expect(store().review.candidates).toEqual([]);
  });

  it("re-reads the queue even when the action fails, and throws", async () => {
    await store().actions.load("/repo");
    candidates = [entry(3, "maybe", { state: "candidate" })];
    await expect(
      store().actions.reviewAction(async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(store().review.candidates).toHaveLength(1);
  });
});
