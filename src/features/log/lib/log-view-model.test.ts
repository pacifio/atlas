import { describe, expect, it } from "vitest";
import type { LogEntry } from "../stores/log-store";
import {
  defaultLogFilters,
  filterLogEntries,
  formatLogLine,
  LOG_SOURCES,
  mergeLogEntries,
} from "./log-view-model";

const entry = (id: string, over: Partial<LogEntry> = {}): LogEntry => ({
  id,
  timestamp: "2026-09-18T09:00:00Z",
  source: "agent",
  kind: "turn",
  summary: `summary ${id}`,
  projectPath: "/p/a",
  projectName: "a",
  ...over,
});

describe("mergeLogEntries", () => {
  it("lists the buffer then the pins, an entry in both once", () => {
    const merged = mergeLogEntries(
      [entry("1"), entry("2")],
      [entry("2", { pinned: true }), entry("3", { pinned: true })],
    );
    expect(merged.map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(merged[1].pinned).toBeUndefined();
  });
});

describe("filterLogEntries", () => {
  const rows = [
    entry("1", { source: "git", kind: "push", summary: "rejected" }),
    entry("2", { source: "editor", pinned: true }),
    entry("3", { projectPath: "/p/b", projectName: "beta" }),
  ];
  const all = { ...defaultLogFilters(), scope: "all" as const };

  it("defaults to every source, the current project, pins and buffer alike", () => {
    const f = defaultLogFilters();
    expect([...f.sources]).toEqual([...LOG_SOURCES]);
    expect(f).toMatchObject({ search: "", scope: "current", pinnedOnly: false });
  });

  it("drops sources that are switched off", () => {
    const sources = new Set(LOG_SOURCES.filter((s) => s !== "git"));
    expect(filterLogEntries(rows, { ...all, sources }, null).map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("keeps only pins when pinned-only is on", () => {
    expect(filterLogEntries(rows, { ...all, pinnedOnly: true }, null).map((e) => e.id)).toEqual([
      "2",
    ]);
  });

  it("scopes to the current project, and shows nothing with none open", () => {
    const current = defaultLogFilters();
    expect(filterLogEntries(rows, current, "/p/a").map((e) => e.id)).toEqual(["1", "2"]);
    expect(filterLogEntries(rows, current, null)).toEqual([]);
    expect(filterLogEntries(rows, all, null)).toHaveLength(3);
  });

  it("searches summary, kind and project name, case-insensitively", () => {
    const search = (q: string) =>
      filterLogEntries(rows, { ...all, search: q }, null).map((e) => e.id);
    expect(search("REJECTED")).toEqual(["1"]);
    expect(search("push")).toEqual(["1"]);
    expect(search("beta")).toEqual(["3"]);
    expect(search("  ")).toHaveLength(3);
  });
});

describe("formatLogLine", () => {
  it("is source, kind and summary on one line", () => {
    expect(formatLogLine(entry("1", { source: "git", kind: "push", summary: "rejected" }))).toBe(
      "[git] push — rejected",
    );
  });
});
