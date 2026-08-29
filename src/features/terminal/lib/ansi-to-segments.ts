/**
 * Minimal ANSI (SGR) → styled-segment renderer for static, completed-command
 * block output. Handles the SGR subset that ordinary CLI
 * output uses: reset, bold/dim/italic/underline/inverse, and 16 / 256 /
 * truecolor foreground+background. Cursor-movement / erase / alt-screen
 * sequences are STRIPPED here — anything interactive runs in xterm instead, so
 * a static block never contains them.
 *
 * Returns an array of `{ text, style }` runs that React renders as <span>s — no
 * dangerouslySetInnerHTML.
 */
import type { CSSProperties } from "react";

export interface AnsiSegment {
  text: string;
  style?: CSSProperties;
}

// Standard 16-color palette (xterm-ish, tuned to read on the black terminal bg).
const PALETTE_16 = [
  "#1a1a1a",
  "#e06c75",
  "#98c379",
  "#e5c07b",
  "#61afef",
  "#c678dd",
  "#56b6c2",
  "#cccccc",
  "#5c6370",
  "#e06c75",
  "#98c379",
  "#e5c07b",
  "#61afef",
  "#c678dd",
  "#56b6c2",
  "#ffffff",
];

function color256(n: number): string {
  if (n < 16) return PALETTE_16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10; // grayscale ramp
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

interface SgrState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

function styleOf(s: SgrState): CSSProperties | undefined {
  const fg = s.inverse ? s.bg : s.fg;
  const bg = s.inverse ? s.fg : s.bg;
  const style: CSSProperties = {};
  if (fg) style.color = fg;
  if (bg) style.background = bg;
  if (s.bold) style.fontWeight = 600;
  if (s.dim) style.opacity = 0.6;
  if (s.italic) style.fontStyle = "italic";
  if (s.underline) style.textDecoration = "underline";
  return Object.keys(style).length ? style : undefined;
}

function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      state.fg = state.bg = undefined;
      state.bold = state.dim = state.italic = state.underline = state.inverse = false;
    } else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 7) state.inverse = true;
    else if (p === 22) state.bold = state.dim = false;
    else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p === 27) state.inverse = false;
    else if (p >= 30 && p <= 37) state.fg = PALETTE_16[p - 30];
    else if (p >= 90 && p <= 97) state.fg = PALETTE_16[p - 90 + 8];
    else if (p >= 40 && p <= 47) state.bg = PALETTE_16[p - 40];
    else if (p >= 100 && p <= 107) state.bg = PALETTE_16[p - 100 + 8];
    else if (p === 39) state.fg = undefined;
    else if (p === 49) state.bg = undefined;
    else if (p === 38 || p === 48) {
      const isFg = p === 38;
      const mode = params[i + 1];
      if (mode === 5) {
        const col = color256(params[i + 2] ?? 0);
        if (isFg) state.fg = col;
        else state.bg = col;
        i += 2;
      } else if (mode === 2) {
        const col = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
        if (isFg) state.fg = col;
        else state.bg = col;
        i += 4;
      }
    }
  }
}

const ESC = 0x1b;

/**
 * Resolve in-place terminal updates (carriage return, backspace, cursor
 * movement, erase-line) into the final visible lines, then style them.
 *
 * The plain `ansiToSegments` below drops `\r`/cursor sequences, which is correct
 * for already-static output but WRONG for a spinner / progress bar / interactive
 * prompt that redraws the same line(s) with `\r` + cursor control — those frames
 * concatenate into one long wrapped line. This runs a tiny terminal emulator
 * (cursor over a grid of styled cells) so a `\r⠙ Waiting…\r⠸ Waiting…` stream
 * collapses to a single updating line, exactly as a real terminal shows it.
 *
 * Returns flattened segments with `\n` between resolved lines so the existing
 * `white-space: pre-wrap` block renderer works unchanged.
 */
export function resolveTerminalOutput(input: string): AnsiSegment[] {
  interface Cell {
    ch: string;
    style?: CSSProperties;
  }
  const lines: Cell[][] = [[]];
  let row = 0;
  let col = 0;
  const state: SgrState = {};
  let curStyle = styleOf(state);

  const lineAt = (r: number): Cell[] => {
    while (lines.length <= r) lines.push([]);
    return lines[r];
  };
  const putChar = (ch: string) => {
    const line = lineAt(row);
    while (line.length < col) line.push({ ch: " " });
    line[col] = { ch, style: curStyle };
    col++;
  };

  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input.charCodeAt(i);
    if (ch === ESC && input[i + 1] === "[") {
      let j = i + 2;
      while (j < n && !/[@-~]/.test(input[j])) j++;
      const final = input[j];
      const body = input.slice(i + 2, j);
      const num = (def: number) => {
        const v = parseInt(body, 10);
        return Number.isNaN(v) ? def : v;
      };
      if (final === "m") {
        const params = body.split(";").map((x) => (x === "" ? 0 : parseInt(x, 10)));
        applySgr(state, params.length ? params : [0]);
        curStyle = styleOf(state);
      } else if (final === "A") row = Math.max(0, row - num(1));
      else if (final === "B") row = row + num(1);
      else if (final === "C") col = col + num(1);
      else if (final === "D") col = Math.max(0, col - num(1));
      else if (final === "G") col = Math.max(0, num(1) - 1);
      else if (final === "H" || final === "f") {
        // Cursor position row;col (1-based). Only used by some prompts.
        const [r, c] = body.split(";").map((x) => parseInt(x, 10));
        row = Math.max(0, (Number.isNaN(r) ? 1 : r) - 1);
        col = Math.max(0, (Number.isNaN(c) ? 1 : c) - 1);
      } else if (final === "K") {
        const line = lineAt(row);
        const mode = num(0);
        if (mode === 0) line.length = Math.min(line.length, col);
        else if (mode === 1) for (let k = 0; k < col && k < line.length; k++) line[k] = { ch: " " };
        else if (mode === 2) line.length = 0;
      } else if (final === "J") {
        // Erase in display. `ESC[J` is how a prompt library clears the frame it
        // is about to redraw: cursor up to the top of the old frame, erase
        // everything below, write the new one. Ignoring it (as this did) leaves
        // every previous frame on screen under the new one — the taller old
        // frame's tail survives as garbage on the right of the new lines.
        const line = lineAt(row);
        const mode = num(0);
        if (mode === 0) {
          // Cursor → end of display.
          line.length = Math.min(line.length, col);
          lines.length = row + 1;
        } else if (mode === 1) {
          // Start of display → cursor.
          for (let r = 0; r < row; r++) lines[r] = [];
          for (let k = 0; k < col && k < line.length; k++) line[k] = { ch: " " };
        } else {
          // 2 / 3 — the whole display. Blanked in place rather than removed:
          // the cursor does not move, so the rows have to keep existing.
          for (let r = 0; r < lines.length; r++) lines[r] = [];
        }
      }
      // Other CSI (scroll regions, mode set/reset, etc.) ignored — block output.
      i = j + 1;
      continue;
    }
    if (ch === ESC && (input[i + 1] === "]" || input[i + 1] === ")" || input[i + 1] === "(")) {
      let j = i + 2;
      while (
        j < n &&
        input.charCodeAt(j) !== 0x07 &&
        !(input.charCodeAt(j) === ESC && input[j + 1] === "\\")
      )
        j++;
      i = input.charCodeAt(j) === ESC ? j + 2 : j + 1;
      continue;
    }
    if (ch === ESC) {
      i += 2;
      continue;
    }
    if (ch === 0x0d) {
      col = 0; // carriage return — overwrite from column 0
      i++;
      continue;
    }
    if (ch === 0x0a) {
      row++; // line feed — next row (CRLF already moved col to 0)
      lineAt(row);
      i++;
      continue;
    }
    if (ch === 0x08) {
      col = Math.max(0, col - 1); // backspace
      i++;
      continue;
    }
    if (ch === 0x07) {
      i++; // bell
      continue;
    }
    putChar(input[i]);
    i++;
  }

  // Flatten the grid → segments, merging adjacent cells that share a style.
  const out: AnsiSegment[] = [];
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    let buf = "";
    let style = line[0]?.style;
    for (const cell of line) {
      if (cell.style === style) buf += cell.ch;
      else {
        if (buf) out.push({ text: buf, style });
        buf = cell.ch;
        style = cell.style;
      }
    }
    if (buf) out.push({ text: buf, style });
    if (r < lines.length - 1) out.push({ text: "\n" });
  }
  return out;
}
