import { describe, expect, it, vi } from "vitest";
import { BlockStreamParser } from "./block-parser";

const OSC = (body: string) => `\x1b]${body}\x07`;
const PROMPT = OSC("133;A");
const CMD = (c: string) => OSC(`6973;C;${c}`) + OSC("133;C");
const END = (code: number) => OSC(`133;D;${code}`) + OSC("133;A");

function make() {
  const onChange = vi.fn();
  const sink = vi.fn<(t: string) => void>();
  const p = new BlockStreamParser("/tmp", onChange);
  p.setXtermSink(sink);
  return { p, onChange, sink };
}

describe("BlockStreamParser xterm forwarding", () => {
  it("forwards nothing of plain output while in the normal screen", () => {
    const { p, sink } = make();
    p.push(PROMPT + CMD("cat big.log") + "line one\r\nline two\r\n" + END(0));
    expect(sink).not.toHaveBeenCalled();
  });

  it("forwards mode-affecting sequences even in the normal screen", () => {
    const { p, sink } = make();
    p.push(PROMPT + CMD("app") + "\x1b[?1h\x1b[?25l\x1b[?2004h\x1b(0\x1b7hello");
    const sent = sink.mock.calls.map((c) => c[0]).join("");
    expect(sent).toBe("\x1b[?1h\x1b[?25l\x1b[?2004h\x1b(0\x1b7");
  });

  it("forwards everything verbatim from alt-screen enter through leave", () => {
    const { p, sink } = make();
    const inside = "\x1b[H\x1b[2Jvim screen\x1b[1;1H";
    p.push(PROMPT + CMD("vim") + "before" + "\x1b[?1049h" + inside);
    p.push("more" + "\x1b[?1049l" + "after");
    const sent = sink.mock.calls.map((c) => c[0]).join("");
    expect(sent).toBe("\x1b[?1049h" + inside + "more" + "\x1b[?1049l");
    expect(p.altScreen).toBe(false);
  });

  it("does not append alt-screen bytes to the block's output", () => {
    const { p } = make();
    p.push(PROMPT + CMD("vim") + "\x1b[?1049h" + "SCREEN" + "\x1b[?1049l" + END(0));
    const block = p.blocks[p.blocks.length - 1];
    expect(block.output).not.toContain("SCREEN");
  });

  it("holds an incomplete sequence across pushes instead of forwarding a fragment", () => {
    const { p, sink } = make();
    p.push(PROMPT + CMD("vim") + "\x1b[?1049h" + "abc\x1b[");
    p.push("2Jxyz");
    const sent = sink.mock.calls.map((c) => c[0]).join("");
    expect(sent).toBe("\x1b[?1049habc\x1b[2Jxyz");
  });
});

describe("BlockStreamParser lines", () => {
  it("publishes resolved lines once per flush and freezes them on finish", () => {
    const { p } = make();
    p.push(PROMPT + CMD("echo") + "a\r\nb\r\n");
    p.flushNow();
    const live = p.blocks[p.blocks.length - 1];
    expect(live.lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["a", "b", ""]);
    p.push(END(0));
    const done = p.blocks[p.blocks.length - 1];
    expect(done.running).toBe(false);
    expect(done.lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["a", "b"]);
  });
});

describe("BlockStreamParser events", () => {
  function withEvents() {
    const events: import("./block-parser").TerminalEvent[] = [];
    const p = new BlockStreamParser(
      "/tmp",
      () => {},
      (e) => events.push(e),
    );
    return { p, events };
  }

  it("emits started and finished with command, cwd and exit code", () => {
    const { p, events } = withEvents();
    p.push(PROMPT + CMD("make") + "building\r\n" + END(2));
    const started = events.find((e) => e.type === "commandStarted");
    const finished = events.find((e) => e.type === "commandFinished");
    expect(started).toMatchObject({ command: "make", cwd: "/tmp" });
    expect(finished).toMatchObject({ command: "make", exitCode: 2, usedAltScreen: false });
    if (finished?.type === "commandFinished") expect(finished.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("buffers a marker split across pushes", () => {
    const { p, events } = withEvents();
    const stream = PROMPT + CMD("ls") + "a\r\n" + END(0);
    for (const ch of stream) p.push(ch);
    expect(events.filter((e) => e.type === "commandFinished")).toHaveLength(1);
  });

  it("emits nothing for the preamble block", () => {
    const { p, events } = withEvents();
    p.push("banner\r\n" + PROMPT);
    expect(
      events.filter((e) => e.type !== "altScreenEnter" && e.type !== "altScreenLeave"),
    ).toEqual([]);
  });

  it("reports a bell during a command once, drops the byte, ignores prompt bells", () => {
    const { p, events } = withEvents();
    p.push(PROMPT + "\x07" + CMD("build") + "warn\x07ing\r\n");
    const bells = events.filter((e) => e.type === "attention" && e.kind === "bell");
    expect(bells).toHaveLength(1);
    expect(p.blocks[p.blocks.length - 1].output).not.toContain("\x07");
  });

  it("parses OSC 9 and OSC 777 as notify attention", () => {
    const { p, events } = withEvents();
    p.push(PROMPT + CMD("deploy") + OSC("9;All done") + OSC("777;notify;Deploy;Finished OK"));
    const notes = events.filter((e) => e.type === "attention" && e.kind === "notify");
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatchObject({ title: "Deploy", body: "Finished OK" });
  });

  it("ignores ConEmu progress OSC 9", () => {
    const { p, events } = withEvents();
    p.push(PROMPT + CMD("x") + OSC("9;4;1;50"));
    expect(events.filter((e) => e.type === "attention")).toHaveLength(0);
  });

  it("flags usedAltScreen when the command took the alt screen", () => {
    const { p, events } = withEvents();
    p.push(PROMPT + CMD("vim") + "\x1b[?1049h" + "S" + "\x1b[?1049l" + END(0));
    const finished = events.find((e) => e.type === "commandFinished");
    expect(finished).toMatchObject({ usedAltScreen: true });
    expect(events.some((e) => e.type === "altScreenEnter")).toBe(true);
    expect(events.some((e) => e.type === "altScreenLeave")).toBe(true);
  });

  it("emits exactly one password attention across pushes", () => {
    const { p, events } = withEvents();
    p.push(PROMPT + CMD("sudo true") + "[sudo] pass");
    p.push("word for adib: ");
    p.push("");
    const pw = events.filter((e) => e.type === "attention" && e.kind === "password");
    expect(pw).toHaveLength(1);
  });
});
