import { describe, expect, it } from "vitest";
import { LineEmulator, linesToSegments } from "./line-emulator";
import { resolveTerminalOutput } from "./ansi-to-segments";

const text = (emu: LineEmulator) =>
  linesToSegments(emu.snapshot().lines)
    .map((s) => s.text)
    .join("");

/** Split `s` into random chunks — the byte stream never respects line ends. */
function chunks(s: string, seed: number): string[] {
  const out: string[] = [];
  let i = 0;
  let x = seed;
  while (i < s.length) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (x % 7);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

const CORPUS = [
  "hello\r\nworld",
  "one (recommended)\r\ntwo\r\nthree\r\n\x1b[3A\x1b[Jone\r\ntwo\r\n",
  "abcdef\x1b[3D\x1b[J",
  // progress bar redrawing one line
  Array.from({ length: 30 }, (_, i) => `\r[${String(i).padStart(3)}%] building…`).join("") + "\n",
  // SGR-heavy build output
  "\x1b[32m✓\x1b[0m built \x1b[1m12\x1b[22m modules in \x1b[33m1.2s\x1b[0m\n\x1b[31merror\x1b[0m: nope\n",
  // clack-style frame redraw
  "◆ Pick one\n│ ● a\n│ ○ b\n└\n\x1b[4A\x1b[J◆ Pick one\n│ ○ a\n│ ● b\n└\n",
  // backspace edit
  "typo\b\bpe\n",
  // erase line modes
  "keep this\x1b[1G\x1b[Kgone\n12345\x1b[3G\x1b[0K\nabc\x1b[2K\n",
];

describe("LineEmulator", () => {
  it("matches the one-shot resolver for every corpus entry, in random chunk splits", () => {
    for (const s of CORPUS) {
      const expected = resolveTerminalOutput(s)
        .map((x) => x.text)
        .join("");
      for (const seed of [1, 7, 42]) {
        const emu = new LineEmulator({ hotRows: 64, maxLines: 10_000 });
        for (const c of chunks(s, seed)) emu.push(c);
        expect(text(emu), JSON.stringify(s)).toBe(expected);
      }
    }
  });

  it("appends plain output line by line (the PTY's onlcr makes every LF a CRLF)", () => {
    const emu = new LineEmulator({ hotRows: 4, maxLines: 100 });
    emu.push("a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n");
    const snap = emu.snapshot();
    expect(snap.lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "",
    ]);
  });

  it("keeps committed line identity across flushes and only rebuilds the hot tail", () => {
    const emu = new LineEmulator({ hotRows: 2, maxLines: 100 });
    emu.push("l1\r\nl2\r\nl3\r\nl4\r\n");
    const a = emu.snapshot().lines;
    emu.push("l5\r\n");
    const b = emu.snapshot().lines;
    // l1..l3 are committed by now (6 rows, hot window of 2).
    expect(b[0]).toBe(a[0]);
    expect(b[1]).toBe(a[1]);
    expect(b[2]).toBe(a[2]);
    expect(b.length).toBe(a.length + 1);
  });

  it("clamps cursor-up at the hot window instead of throwing", () => {
    const emu = new LineEmulator({ hotRows: 2, maxLines: 100 });
    emu.push("a\r\nb\r\nc\r\nd\r\n");
    expect(() => emu.push("\x1b[50Ax\r\n")).not.toThrow();
    // The committed history is untouched by the redraw.
    const lines = emu.snapshot().lines.map((l) => l.segments.map((s) => s.text).join(""));
    expect(lines[0]).toBe("a");
  });

  it("drops from the front past maxLines and reports it", () => {
    const emu = new LineEmulator({ hotRows: 1, maxLines: 3 });
    emu.push("1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n");
    const snap = emu.snapshot();
    expect(snap.dropped).toBeGreaterThan(0);
    expect(snap.lines.length).toBeLessThanOrEqual(3 + 1);
  });

  it("finish() trims trailing blank rows and freezes", () => {
    const emu = new LineEmulator({ hotRows: 8, maxLines: 100 });
    emu.push("done\r\n\r\n\r\n");
    const lines = emu.finish();
    expect(lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["done"]);
  });

  it("interns styles so equal SGR states share one object", () => {
    const emu = new LineEmulator({ hotRows: 8, maxLines: 100 });
    emu.push("\x1b[31ma\x1b[0m \x1b[31mb\x1b[0m\r\n");
    const segs = emu.snapshot().lines[0].segments;
    const red = segs.filter((s) => s.style);
    expect(red).toHaveLength(2);
    expect(red[0].style).toBe(red[1].style);
  });
});
