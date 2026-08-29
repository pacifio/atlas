import { describe, expect, it } from "vitest";
import { resolveTerminalOutput } from "./ansi-to-segments";

const render = (s: string) =>
  resolveTerminalOutput(s)
    .map((x) => x.text)
    .join("");

describe("resolveTerminalOutput", () => {
  // A prompt library (@clack, Ink) redraws by moving the cursor to the top of
  // the frame it drew last and erasing everything below before writing the new
  // one. While `ESC[J` was ignored, the taller old frame survived underneath —
  // its tail showing to the right of the new, shorter lines.
  it("erases the previous frame on ESC[J", () => {
    const stream =
      "one (recommended)\r\ntwo\r\nthree\r\n" + "\x1b[3A" + "\x1b[J" + "one\r\ntwo\r\n";
    expect(render(stream)).toBe("one\ntwo\n");
  });

  it("truncates the cursor's own line on ESC[J", () => {
    expect(render("abcdef" + "\x1b[3D" + "\x1b[J")).toBe("abc");
  });

  it("leaves output with no erase sequence untouched", () => {
    expect(render("hello\r\nworld")).toBe("hello\nworld");
  });
});
