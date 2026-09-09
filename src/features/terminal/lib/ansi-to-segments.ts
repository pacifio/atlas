/**
 * ANSI (SGR + line discipline) → styled segments.
 *
 * The emulation itself lives in `line-emulator.ts`, which the block parser
 * drives INCREMENTALLY as output streams. This module keeps the segment type
 * and a one-shot convenience for callers that have a whole string in hand
 * (tests, copy paths): it runs the same emulator over the input with an
 * unbounded hot window, so the result is exactly what the incremental path
 * would have produced for the same bytes.
 *
 * Returns `{ text, style }` runs that React renders as <span>s — no
 * dangerouslySetInnerHTML.
 */
import type { CSSProperties } from "react";
import { LineEmulator, linesToSegments } from "./line-emulator";

export interface AnsiSegment {
  text: string;
  style?: CSSProperties;
}

/**
 * Resolve in-place terminal updates (carriage return, backspace, cursor
 * movement, erase-line) into the final visible lines, then style them.
 *
 * A spinner / progress bar / interactive prompt redraws the same line(s) with
 * `\r` + cursor control; concatenating the frames would give one long wrapped
 * line. The emulator collapses `\r⠙ Waiting…\r⠸ Waiting…` to a single updating
 * line, exactly as a real terminal shows it.
 *
 * Returns flattened segments with `\n` between resolved lines.
 */
export function resolveTerminalOutput(input: string): AnsiSegment[] {
  const emu = new LineEmulator({
    hotRows: Number.MAX_SAFE_INTEGER,
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  emu.push(input);
  return linesToSegments(emu.finish(false));
}
