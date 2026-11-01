import { describe, expect, it, vi } from "vitest";

import { readSessionDetail, type DetailSources } from "./read-session-detail";
import type { SessionDetail } from "../types";

function detail(id: string): SessionDetail {
  return {
    summary: { id } as SessionDetail["summary"],
    entries: [],
    counts: { prompts: 0, responses: 0, thinking: 0, toolCalls: 0, checkpoints: 0 },
    tools: [],
  };
}

function sources(over: Partial<DetailSources> = {}): DetailSources {
  return {
    local: vi.fn(async () => null),
    remote: vi.fn(async (_p: string, id: string) => detail(id)),
    ...over,
  };
}

describe("readSessionDetail", () => {
  it("prefers the local store when the Session is in it", async () => {
    const io = sources({ local: vi.fn(async (_p, id) => detail(id)) });
    const out = await readSessionDetail(
      { sessionId: "ses_1", projectPath: "/repo", remoteProjectId: "ws_1" },
      io,
    );
    expect(out?.summary.id).toBe("ses_1");
    expect(io.remote).not.toHaveBeenCalled();
  });

  it("falls back to the server for a teammate's Session in a Project this machine has", async () => {
    // The bug: the board gives every Session of a bound Project a local
    // `projectPath`, including rows that only ever existed on the server. A
    // local miss must not be the end of the story.
    const io = sources();
    const out = await readSessionDetail(
      { sessionId: "ses_theirs", projectPath: "/repo", remoteProjectId: "ws_1" },
      io,
    );
    expect(io.local).toHaveBeenCalledWith("/repo", "ses_theirs");
    expect(io.remote).toHaveBeenCalledWith("ws_1", "ses_theirs");
    expect(out?.summary.id).toBe("ses_theirs");
  });

  it("reads straight from the server when there is no checkout", async () => {
    const io = sources();
    await readSessionDetail({ sessionId: "ses_2", projectPath: "", remoteProjectId: "ws_1" }, io);
    expect(io.local).not.toHaveBeenCalled();
    expect(io.remote).toHaveBeenCalledWith("ws_1", "ses_2");
  });

  it("answers null, without asking the server, for a local-only Session that is gone", async () => {
    const io = sources();
    const out = await readSessionDetail(
      { sessionId: "ses_3", projectPath: "/repo", remoteProjectId: null },
      io,
    );
    expect(out).toBeNull();
    expect(io.remote).not.toHaveBeenCalled();
  });

  it("lets a server refusal surface as an error rather than as absence", async () => {
    const io = sources({
      remote: vi.fn(async () => {
        throw new Error("session: not found");
      }),
    });
    await expect(
      readSessionDetail({ sessionId: "ses_4", projectPath: "", remoteProjectId: "ws_1" }, io),
    ).rejects.toThrow("not found");
  });
});

describe("readSessionDetail, streamed", () => {
  const remoteOnly = { sessionId: "ses_s", projectPath: "", remoteProjectId: "ws_1" };
  const entry = (id: string) => ({ id }) as SessionDetail["entries"][number];
  const withEntries = (ids: string[]): SessionDetail => ({
    ...detail("ses_s"),
    entries: ids.map(entry),
  });

  it("hands each page over as a growing prefix, then resolves with the whole Session", async () => {
    const io = sources({
      stream: vi.fn(async (_p, _s, onChunk) => {
        onChunk({ kind: "page", detail: withEntries(["a", "b"]), done: false });
        onChunk({ kind: "page", detail: withEntries(["c"]), done: true });
      }),
    });
    const seen: [string[], boolean][] = [];
    const out = await readSessionDetail(remoteOnly, io, (d, complete) =>
      seen.push([d.entries.map((e) => e.id), complete]),
    );
    expect(seen).toEqual([
      [["a", "b"], false],
      [["a", "b", "c"], true],
    ]);
    expect(out?.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(io.remote).not.toHaveBeenCalled();
  });

  it("shows the disk copy at once and keeps it when the server says it is current", async () => {
    const io = sources({
      stream: vi.fn(async (_p, _s, onChunk) => {
        onChunk({ kind: "cached", detail: withEntries(["a", "b"]) });
        onChunk({ kind: "unchanged" });
      }),
    });
    const progress = vi.fn();
    const out = await readSessionDetail(remoteOnly, io, progress);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [entry("a"), entry("b")] }),
      true,
    );
    expect(out?.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("never swaps a disk copy for a prefix of the newer read", async () => {
    const io = sources({
      stream: vi.fn(async (_p, _s, onChunk) => {
        onChunk({ kind: "cached", detail: withEntries(["a"]) });
        onChunk({ kind: "page", detail: withEntries(["a", "b"]), done: false });
        onChunk({ kind: "page", detail: withEntries(["c"]), done: true });
      }),
    });
    const progress = vi.fn();
    const out = await readSessionDetail(remoteOnly, io, progress);
    // Only the disk copy was shown; the newer Session arrives whole, at the end.
    expect(progress).toHaveBeenCalledTimes(1);
    expect(out?.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects a read Rust stopped part-way, rather than passing a prefix off as the Session", async () => {
    const io = sources({
      stream: vi.fn(async (_p, _s, onChunk) => {
        onChunk({ kind: "page", detail: withEntries(["a"]), done: false });
      }),
    });
    await expect(readSessionDetail(remoteOnly, io, vi.fn())).rejects.toThrow(/superseded/);
  });

  it("reads whole, as before, when no one is listening for progress", async () => {
    const io = sources({ stream: vi.fn() });
    await readSessionDetail(remoteOnly, io);
    expect(io.stream).not.toHaveBeenCalled();
    expect(io.remote).toHaveBeenCalledWith("ws_1", "ses_s");
  });
});
