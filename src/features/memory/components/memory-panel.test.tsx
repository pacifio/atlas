// @vitest-environment happy-dom
// The Memory panel's Memories tab and its ⋯ menu: each memory shows who wrote
// it and how sure the record is; choosing one opens it beside the list with
// where it came from, and it can be edited, marked, forgotten or erased from
// there. The menu imports, exports to AGENTS.md and clears.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const pickFolder = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => pickFolder(...args) }));

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { MemoryPanel } from "./memory-panel";
import { useSharedMemoryStore, EMPTY_REVIEW } from "../stores/shared-memory-store";
import { useMemoryStore } from "../stores/memory-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useAskAgentStore } from "@/features/ask-agent/stores/ask-agent-store";

function entry(id: number, content: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "failure",
    key: "",
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
  };
}

let entries: ReturnType<typeof entry>[] = [];

function importLine(id: string, kind: string, content: string, isNew = true) {
  return { id, kind, content, file: `${id}.md`, claudeType: "project", isNew };
}

let preview = {
  sources: ["/home/.claude/projects/-repo/memory"],
  alreadyImported: false,
  lines: [] as ReturnType<typeof importLine>[],
};

beforeEach(() => {
  entries = [
    entry(1, "Mocking the DB hid a migration bug"),
    entry(2, "Prefers small PRs", {
      kind: "fact",
      source: "import:claude",
      agent: "",
      confidence: 0.7,
    }),
  ];
  preview = {
    sources: ["/home/.claude/projects/-repo/memory"],
    alreadyImported: false,
    lines: [
      importLine("d1", "decision", "JWT signing uses RS256 instead of HS256"),
      importLine("f1", "fact", "Merge freeze begins 2026-03-05"),
      importLine("f2", "fact", "Prefers small PRs", false),
    ],
  };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "memory_list_events") return [];
    if (cmd === "memory_list_entries") return entries;
    if (cmd === "memory_review") return EMPTY_REVIEW;
    // The destination bar's sharing controls.
    if (cmd === "memory_sharing_get") return true;
    if (cmd === "memory_from_external_sessions_get") return false;
    if (cmd === "memory_summarizer_get") return { mode: "raw", provider: "", model: "" };
    if (cmd === "byok_list") return [];
    if (cmd === "memory_edit_entry") {
      const edited = entry(args.id as number, args.content as string, {
        source: "user",
        agent: "user",
        confidence: 1,
      });
      entries = entries.map((e) => (e.id === args.id ? edited : e));
      return edited;
    }
    if (cmd === "memory_feedback_entry") {
      const target = entries.find((e) => e.id === args.id)!;
      const marked =
        args.verdict === "wrong"
          ? { ...target, confidence: 0.2, state: "archived" }
          : { ...target, confidence: 0.4, state: "candidate" };
      entries = entries.map((e) => (e.id === args.id ? marked : e));
      return marked;
    }
    if (cmd === "memory_promote") {
      entries = entries.map((e) => (e.id === args.id ? { ...e, state: "active" } : e));
      return true;
    }
    if (cmd === "memory_claude_import_preview") return preview;
    if (cmd === "memory_export_preview")
      return {
        path: "/repo/AGENTS.md",
        before: "",
        after: "<!-- atlas-memory:begin -->\n<!-- atlas-memory:end -->",
      };
    if (cmd === "memory_export_apply") return "/repo/AGENTS.md";
    if (cmd === "memory_claude_import_confirm") {
      const ids = args.ids as string[];
      for (const line of preview.lines.filter((l) => ids.includes(l.id))) {
        entries = [
          entry(100 + entries.length, line.content, {
            kind: line.kind,
            source: "import:claude",
            agent: "",
            confidence: 0.7,
          }),
          ...entries,
        ];
      }
      return ids.length;
    }
    if (cmd === "memory_forget_entry" || cmd === "memory_purge_entry") {
      entries = entries.filter((e) => e.id !== args.id);
      return true;
    }
    if (cmd === "memory_entry_provenance") {
      return [
        {
          source: "atlas-session:claude-code/s-a",
          agent: "claude-code",
          added: "2026-10-05",
          title: "Move auth to EdDSA",
          commits: ["3f9c2ab1d4e0"],
        },
      ];
    }
    return null;
  });
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  useAppStore.setState({ currentProject: { path: "/repo", name: "repo" } as never });
  useMemoryStore.setState({ subTab: "memories", focusEntryId: null });
  useSharedMemoryStore.setState({
    projectPath: null,
    loaded: false,
    entries: [],
    error: null,
    review: EMPTY_REVIEW,
    reviewError: null,
  });
});

afterEach(cleanup);

function row(content: string): HTMLElement {
  return screen.getByRole("button", { name: content }).closest<HTMLElement>("[data-entry-id]")!;
}

async function open(content: string) {
  const user = userEvent.setup();
  render(<MemoryPanel />);
  await user.click(await screen.findByRole("button", { name: content }));
  return { user, pane: await screen.findByRole("complementary", { name: "Memory detail" }) };
}

async function menu(user: ReturnType<typeof userEvent.setup>, item: string) {
  await user.click(await screen.findByRole("button", { name: "More memory actions" }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

describe("the Memories list", () => {
  it("says who wrote each memory and how sure the record is", async () => {
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Mocking the DB hid a migration bug" });
    expect(within(row("Mocking the DB hid a migration bug")).getByText("60% sure")).toBeTruthy();
    const imported = row("Prefers small PRs");
    expect(within(imported).getByText(/Imported from claude/)).toBeTruthy();
    expect(within(imported).getByText("70% sure")).toBeTruthy();
  });

  it("marks an unconfirmed memory in its row", async () => {
    entries = [
      entry(3, "always force-push", { state: "candidate", source: "capture", confidence: 0.3 }),
    ];
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "always force-push" });
    expect(within(row("always force-push")).getByText("Unconfirmed")).toBeTruthy();
  });

  it("keeps archived memories out of Current, and shows them under Archived", async () => {
    entries = [entry(1, "Live line"), entry(4, "Retired the old queue", { state: "archived" })];
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Live line" });
    expect(screen.queryByRole("button", { name: "Retired the old queue" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: /Archived/ }));
    expect(await screen.findByRole("button", { name: "Retired the old queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Live line" })).toBeNull();
  });

  it("finds a memory by its words", async () => {
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });
    await user.type(screen.getByRole("searchbox", { name: "Search memories" }), "migration");
    expect(screen.queryByRole("button", { name: "Prefers small PRs" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mocking the DB hid a migration bug" })).toBeTruthy();
  });

  it("opens the entry the Memory updated card asked for, once", async () => {
    useMemoryStore.setState({ focusEntryId: 2 });
    render(<MemoryPanel />);
    const pane = await screen.findByRole("complementary", { name: "Memory detail" });
    expect(within(pane).getByText("Prefers small PRs")).toBeTruthy();
    expect(useMemoryStore.getState().focusEntryId).toBeNull();
  });

  it("says when the record can't be read, and offers a retry instead of an empty list", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "memory_list_entries") throw new Error("database is locked");
      return base(cmd, args);
    });
    render(<MemoryPanel />);
    expect(await screen.findByText("Couldn't read this project's memory")).toBeTruthy();
    expect(screen.queryByText("Nothing remembered here yet")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("says Review can't be read when the record is locked, not that nothing waits", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "memory_list_entries" || cmd === "memory_review")
        throw new Error("database is locked");
      return base(cmd, args);
    });
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByText("Couldn't read this project's memory");
    await user.click(screen.getByRole("radio", { name: /Review/ }));
    expect(await screen.findByText("Couldn't read the review queue")).toBeTruthy();
    expect(screen.queryByText("Nothing to review")).toBeNull();
  });

  it("drops the open memory and the export picks in another project", async () => {
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });
    await menu(user, "Export to AGENTS.md…");
    await user.click(screen.getByRole("checkbox", { name: "Pick Prefers small PRs" }));
    await user.click(screen.getByRole("button", { name: "Prefers small PRs" }));
    await screen.findByRole("complementary", { name: "Memory detail" });

    // Another project whose entries reuse the same ids.
    entries = [entry(2, "Other project's line", { kind: "fact" })];
    act(() => useAppStore.setState({ currentProject: { path: "/other", name: "other" } as never }));
    await screen.findByRole("button", { name: "Other project's line" });
    expect(screen.queryByRole("complementary", { name: "Memory detail" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("the prompt line", () => {
  it("opens the ask box as a memory instruction, with the project's memory", async () => {
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });
    await user.click(screen.getByRole("button", { name: /Tell the agent what to remember/ }));
    const request = useAskAgentStore.getState().request;
    expect(request?.prompt).toBe("Update this project's shared memory: ");
    expect(request?.context).toHaveLength(1);
    const digest = request?.context[0];
    expect(digest?.kind === "quote" && digest.text).toContain("Prefers small PRs");
  });
});

describe("a chosen memory", () => {
  it("says where it was learned, with the session's commit", async () => {
    const { pane } = await open("Prefers small PRs");
    expect(await within(pane).findByText("“Move auth to EdDSA”")).toBeTruthy();
    expect(within(pane).getByText("3f9c2ab")).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "Open the session" })).toBeTruthy();
  });

  it("asks the agent about it, with the memory as a chip", async () => {
    const { user, pane } = await open("Prefers small PRs");
    await user.click(within(pane).getByRole("button", { name: /Ask agent…/ }));
    const request = useAskAgentStore.getState().request;
    expect(request?.context).toEqual([
      {
        kind: "memory_entry",
        id: "2",
        memoryKind: expect.any(String),
        text: "Prefers small PRs",
        project: "repo",
      },
    ]);
    expect(request?.anchor).toBeInstanceOf(HTMLElement);
  });

  it("edits in place", async () => {
    const { user, pane } = await open("Mocking the DB hid a migration bug");
    // Behind ⋯: asking the agent is the primary fix.
    await user.click(within(pane).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit by hand" }));
    const field = within(pane).getByRole("textbox", { name: "Memory content" });
    await user.clear(field);
    await user.type(field, "Mocks hid the migration bug");
    await user.click(within(pane).getByRole("button", { name: /Save/ }));

    expect(invoke).toHaveBeenCalledWith("memory_edit_entry", {
      projectPath: "/repo",
      id: 1,
      content: "Mocks hid the migration bug",
    });
    await waitFor(() =>
      expect(within(row("Mocks hid the migration bug")).getByText("You")).toBeTruthy(),
    );
  });

  it("marks a memory as wrong, which archives it", async () => {
    const { user, pane } = await open("Mocking the DB hid a migration bug");
    // One click: the verdicts stay beside "Ask agent…".
    await user.click(within(pane).getByRole("button", { name: "Mark as wrong" }));
    expect(invoke).toHaveBeenCalledWith("memory_feedback_entry", {
      projectPath: "/repo",
      id: 1,
      verdict: "wrong",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Mocking the DB hid a migration bug" }),
      ).toBeNull(),
    );
  });

  it("restores an archived memory", async () => {
    entries = [entry(4, "Retired the old queue", { state: "archived" })];
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await user.click(await screen.findByRole("radio", { name: /Archived/ }));
    await user.click(await screen.findByRole("button", { name: "Retired the old queue" }));
    const pane = await screen.findByRole("complementary", { name: "Memory detail" });
    await user.click(within(pane).getByRole("button", { name: "Restore" }));
    expect(invoke).toHaveBeenCalledWith("memory_promote", { projectPath: "/repo", id: 4 });
  });

  it("forgets after confirming", async () => {
    const { user, pane } = await open("Prefers small PRs");
    await user.click(within(pane).getByRole("button", { name: "Forget" }));
    expect(invoke).not.toHaveBeenCalledWith("memory_forget_entry", expect.anything());
    await screen.findByText("Forget this memory?");
    const buttons = screen.getAllByRole("button", { name: "Forget" });
    // The pane's Forget comes first; the dialog's confirm is the last one.
    await user.click(buttons[buttons.length - 1]);
    expect(invoke).toHaveBeenCalledWith("memory_forget_entry", { projectPath: "/repo", id: 2 });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Prefers small PRs" })).toBeNull(),
    );
  });

  it("keeps the memory open when forgetting it fails", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "memory_forget_entry") throw new Error("database is locked");
      return base(cmd, args);
    });
    const { user, pane } = await open("Prefers small PRs");
    await user.click(within(pane).getByRole("button", { name: "Forget" }));
    await screen.findByText("Forget this memory?");
    const buttons = screen.getAllByRole("button", { name: "Forget" });
    await user.click(buttons[buttons.length - 1]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't forget: database is locked"),
    );
    expect(screen.getByRole("complementary", { name: "Memory detail" })).toBeTruthy();
  });

  it("erases with its history after confirming", async () => {
    const { user, pane } = await open("Prefers small PRs");
    await user.click(within(pane).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Erase with history…" }));
    expect(invoke).not.toHaveBeenCalledWith("memory_purge_entry", expect.anything());
    await user.click(await screen.findByRole("button", { name: "Erase" }));
    expect(invoke).toHaveBeenCalledWith("memory_purge_entry", { projectPath: "/repo", id: 2 });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Prefers small PRs" })).toBeNull(),
    );
  });
});

describe("exporting to AGENTS.md", () => {
  it("picks memories, previews, then writes", async () => {
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });
    // No checkboxes until the export is asked for.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    await menu(user, "Export to AGENTS.md…");
    await user.click(
      screen.getByRole("checkbox", { name: "Pick Mocking the DB hid a migration bug" }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Pick Prefers small PRs" }));
    await user.click(screen.getByRole("button", { name: "Preview export" }));
    expect(invoke).toHaveBeenCalledWith("memory_export_preview", {
      projectPath: "/repo",
      ids: [1, 2],
    });
    const write = await screen.findByRole("button", { name: "Write" });
    await waitFor(() => expect((write as HTMLButtonElement).disabled).toBe(false));
    await user.click(write);
    expect(invoke).toHaveBeenCalledWith("memory_export_apply", {
      projectPath: "/repo",
      ids: [1, 2],
    });
  });

  it("offers only active durable memories", async () => {
    entries = [
      entry(1, "Mocking the DB hid a migration bug"),
      entry(3, "always force-push", { state: "candidate", source: "capture" }),
      entry(5, "Ship the auth refactor", { kind: "plan" }),
    ];
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "always force-push" });
    await menu(user, "Export to AGENTS.md…");
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Pick Mocking the DB hid a migration bug",
    ]);
  });
});

describe("importing Claude's auto-memory", () => {
  async function openImport() {
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });
    await menu(user, "Import Claude's memory…");
    return { user, dialog: await screen.findByRole("dialog") };
  }

  it("previews every mapped line before anything is written", async () => {
    const { dialog } = await openImport();
    await within(dialog).findByText("JWT signing uses RS256 instead of HS256");
    const held = within(dialog).getByText("Prefers small PRs").closest("button")!;
    expect((held as HTMLButtonElement).disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("memory_claude_import_confirm", expect.anything());
  });

  it("writes the kept lines on confirm and lists them", async () => {
    const { user, dialog } = await openImport();
    await user.click(await within(dialog).findByText("Merge freeze begins 2026-03-05"));
    await user.click(within(dialog).getByRole("button", { name: /^Import/ }));
    expect(invoke).toHaveBeenCalledWith("memory_claude_import_confirm", {
      projectPath: "/repo",
      ids: ["d1"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      await screen.findByRole("button", { name: "JWT signing uses RS256 instead of HS256" }),
    ).toBeTruthy();
  });

  it("writes nothing when cancelled", async () => {
    const { user, dialog } = await openImport();
    await within(dialog).findByText("Merge freeze begins 2026-03-05");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("memory_claude_import_confirm", expect.anything());
  });

  it("offers nothing when the source was already imported", async () => {
    preview = {
      ...preview,
      alreadyImported: true,
      lines: preview.lines.map((l) => ({ ...l, isNew: false })),
    };
    const { dialog } = await openImport();
    expect(await within(dialog).findByText(/Already imported/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: /^Import/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});

describe("importing a memory repo", () => {
  it("starts clean after an import and after a folder that fails to preview", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "memory_repo_import_preview") {
        if (args.dir === "/broken") throw new Error("no MEMORY.md");
        return [{ id: "r1", kind: "fact", content: "Uses pnpm", file: "MEMORY.md", isNew: true }];
      }
      if (cmd === "memory_repo_import_confirm") return 1;
      return base(cmd, args);
    });
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });

    pickFolder.mockResolvedValueOnce("/memory-repo");
    await menu(user, "Import a memory repo…");
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await user.click(await within(dialog).findByRole("button", { name: "Import 1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // An import lands in Review.
    expect(useMemoryStore.getState().subTab).toBe("review");

    await menu(user, "Import a memory repo…");
    dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    pickFolder.mockResolvedValueOnce("/memory-repo");
    await user.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await within(dialog).findByRole("button", { name: "Import 1" });
    pickFolder.mockResolvedValueOnce("/broken");
    await user.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    await within(dialog).findByText("Error: no MEMORY.md");
    expect(
      (within(dialog).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("clearing shared memory", () => {
  it("asks before wiping, and wipes only on confirm", async () => {
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });
    await menu(user, "Clear shared memory…");
    expect(invoke).not.toHaveBeenCalledWith("memory_clear_project", expect.anything());
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(invoke).toHaveBeenCalledWith("memory_clear_project", { projectPath: "/repo" });
    await waitFor(() => expect(screen.queryByText("Clear shared memory?")).toBeNull());
  });

  it("closes the dialog and says so when the wipe fails", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "memory_clear_project") throw new Error("database is locked");
      return base(cmd, args);
    });
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await screen.findByRole("button", { name: "Prefers small PRs" });
    await menu(user, "Clear shared memory…");
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't clear shared memory: database is locked"),
    );
    expect(screen.queryByText("Clear shared memory?")).toBeNull();
  });
});
