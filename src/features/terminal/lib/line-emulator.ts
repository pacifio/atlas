/**
 * Incremental line emulator for a command block's output.
 *
 * The old path re-ran a cell-grid emulator over the whole tail of the live
 * block on every flush, allocating one object per character. This keeps the
 * emulation state ACROSS flushes and only ever touches the rows the cursor can
 * still reach, so a flush costs O(bytes in this flush + hot rows) instead of
 * O(everything shown so far).
 *
 * Two tiers of lines:
 *
 *  - `committed` — append-only, immutable `ResolvedLine`s. Once a row has
 *    scrolled further up than the cursor can travel it can never change, so it
 *    is flattened to styled runs exactly once and keeps its object identity for
 *    ever after. React memoises on that identity.
 *  - `hot` — the last `hotRows` rows (the PTY height, floored). This is the
 *    window a `\r`, a backspace, or a `CSI A/B/G/H/K/J` can still redraw. A hot
 *    row lives in RUN form (styled runs, appended to) until a cursor operation
 *    targets a column that is not its end; only then does it MATERIALISE into
 *    parallel `chars`/`styles` arrays, and it flattens back to runs on snapshot.
 *    `cat`, `seq` and build logs never materialise a single row.
 *
 * Styles are interned by SGR signature so equality is referential and adjacent
 * runs merge with a `===`.
 *
 * Deliberate deviations from a full terminal, all documented at the site:
 * `CSI 2J`/`3J` blank only the hot window; `CSI A` clamps at the hot window's
 * top; `CSI H` addresses rows within the hot window.
 */
import type { CSSProperties } from "react";
import type { AnsiSegment } from "./ansi-to-segments";

export interface ResolvedLine {
  /** Stable for the lifetime of the row — the React key. */
  id: number;
  segments: AnsiSegment[];
}

export interface LineEmulatorOptions {
  /** Rows the cursor can still reach. Use the PTY height, floored to 64. */
  hotRows: number;
  /** Committed lines kept; older ones are dropped from the front. */
  maxLines: number;
}

interface HotRow {
  id: number;
  /** Run form. Valid when `cells` is undefined. */
  runs: AnsiSegment[];
  /** Cell form. Present only after a cursor operation targeted the row. */
  cells?: { chars: string[]; styles: (CSSProperties | undefined)[] };
  /** Character count, in either form. */
  length: number;
}

// ── SGR ────────────────────────────────────────────────────────────────────

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
    const v = 8 + (n - 232) * 10;
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

/** Interned styles: one object per distinct SGR state, so `===` is equality. */
const STYLE_CACHE = new Map<string, CSSProperties | undefined>();

function styleOf(s: SgrState): CSSProperties | undefined {
  const fg = s.inverse ? s.bg : s.fg;
  const bg = s.inverse ? s.fg : s.bg;
  const key = `${fg ?? ""}|${bg ?? ""}|${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}`;
  if (STYLE_CACHE.has(key)) return STYLE_CACHE.get(key);
  const style: CSSProperties = {};
  if (fg) style.color = fg;
  if (bg) style.background = bg;
  if (s.bold) style.fontWeight = 600;
  if (s.dim) style.opacity = 0.6;
  if (s.italic) style.fontStyle = "italic";
  if (s.underline) style.textDecoration = "underline";
  const out = Object.keys(style).length ? style : undefined;
  STYLE_CACHE.set(key, out);
  return out;
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

// ── Emulator ───────────────────────────────────────────────────────────────

const ESC = 0x1b;
const CR = 0x0d;
const LF = 0x0a;
const BS = 0x08;
const BEL = 0x07;

let nextLineId = 1;

export class LineEmulator {
  private committed: ResolvedLine[] = [];
  private hot: HotRow[] = [];
  /** Cursor row, as an index into `hot`. */
  private row = 0;
  private col = 0;
  private state: SgrState = {};
  private curStyle: CSSProperties | undefined = undefined;
  private dropped = 0;
  private dirty = false;
  /** An escape sequence cut off at the end of the last `push`. The block
   *  parser only hands over complete sequences, but standalone callers (and
   *  tests) feed arbitrary splits; holding the tail keeps both correct. */
  private pending = "";
  private readonly hotRows: number;
  private readonly maxLines: number;

  constructor(opts: LineEmulatorOptions) {
    this.hotRows = Math.max(1, opts.hotRows);
    this.maxLines = Math.max(1, opts.maxLines);
    this.hot.push(this.newRow());
  }

  /** Lines dropped from the front of `committed` to honour `maxLines`. */
  get droppedLines(): number {
    return this.dropped;
  }

  /** True when something changed since the last `snapshot()`. */
  get isDirty(): boolean {
    return this.dirty;
  }

  private newRow(): HotRow {
    return { id: nextLineId++, runs: [], length: 0 };
  }

  // ── Row access ───────────────────────────────────────────────────────────

  private rowAt(r: number): HotRow {
    while (this.hot.length <= r) this.hot.push(this.newRow());
    return this.hot[r];
  }

  /** Cell form: needed before any write that is not an append at the end. */
  private materialise(h: HotRow): NonNullable<HotRow["cells"]> {
    if (h.cells) return h.cells;
    const chars: string[] = [];
    const styles: (CSSProperties | undefined)[] = [];
    for (const run of h.runs) {
      for (let i = 0; i < run.text.length; i++) {
        chars.push(run.text[i]);
        styles.push(run.style);
      }
    }
    h.cells = { chars, styles };
    h.runs = [];
    return h.cells;
  }

  private flatten(h: HotRow): AnsiSegment[] {
    if (!h.cells) return h.runs.slice();
    const { chars, styles } = h.cells;
    const out: AnsiSegment[] = [];
    let buf = "";
    let style = styles[0];
    for (let i = 0; i < chars.length; i++) {
      if (styles[i] === style) buf += chars[i];
      else {
        if (buf) out.push(style ? { text: buf, style } : { text: buf });
        buf = chars[i];
        style = styles[i];
      }
    }
    if (buf) out.push(style ? { text: buf, style } : { text: buf });
    return out;
  }

  private commitTop(): void {
    // Rows above the hot window can never be reached again: freeze them.
    while (this.hot.length > this.hotRows && this.row > 0) {
      const top = this.hot.shift()!;
      this.committed.push({ id: top.id, segments: this.flatten(top) });
      this.row--;
    }
    if (this.committed.length > this.maxLines) {
      const excess = this.committed.length - this.maxLines;
      this.committed.splice(0, excess);
      this.dropped += excess;
    }
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  private putText(text: string): void {
    if (text.length === 0) return;
    const h = this.rowAt(this.row);
    if (!h.cells && this.col === h.length) {
      // Fast path: append at the end of a run-form row, merging same-style runs.
      const last = h.runs[h.runs.length - 1];
      if (last && last.style === this.curStyle) {
        h.runs[h.runs.length - 1] = this.curStyle
          ? { text: last.text + text, style: this.curStyle }
          : { text: last.text + text };
      } else {
        h.runs.push(this.curStyle ? { text, style: this.curStyle } : { text });
      }
      h.length += text.length;
      this.col += text.length;
      return;
    }
    const cells = this.materialise(h);
    while (cells.chars.length < this.col) {
      cells.chars.push(" ");
      cells.styles.push(undefined);
    }
    for (let i = 0; i < text.length; i++) {
      cells.chars[this.col] = text[i];
      cells.styles[this.col] = this.curStyle;
      this.col++;
    }
    h.length = cells.chars.length;
  }

  private truncateRow(h: HotRow, at: number): void {
    if (at >= h.length) return;
    if (!h.cells) {
      // Truncate runs without materialising.
      let remaining = at;
      const kept: AnsiSegment[] = [];
      for (const run of h.runs) {
        if (remaining <= 0) break;
        if (run.text.length <= remaining) {
          kept.push(run);
          remaining -= run.text.length;
        } else {
          const t = run.text.slice(0, remaining);
          kept.push(run.style ? { text: t, style: run.style } : { text: t });
          remaining = 0;
        }
      }
      h.runs = kept;
      h.length = at;
      return;
    }
    h.cells.chars.length = at;
    h.cells.styles.length = at;
    h.length = at;
  }

  private blankRow(h: HotRow): void {
    h.runs = [];
    h.cells = undefined;
    h.length = 0;
  }

  private blankCells(h: HotRow, from: number, to: number): void {
    const cells = this.materialise(h);
    for (let k = from; k < to && k < cells.chars.length; k++) {
      cells.chars[k] = " ";
      cells.styles[k] = undefined;
    }
  }

  // ── CSI ──────────────────────────────────────────────────────────────────

  private csi(body: string, final: string): void {
    const num = (def: number) => {
      const v = parseInt(body, 10);
      return Number.isNaN(v) ? def : v;
    };
    switch (final) {
      case "m": {
        const params =
          body === "" ? [0] : body.split(";").map((x) => (x === "" ? 0 : parseInt(x, 10)));
        applySgr(this.state, params);
        this.curStyle = styleOf(this.state);
        return;
      }
      case "A":
        // Clamps at the hot window's top: rows above it are committed and
        // cannot be redrawn. A real terminal would clamp at the screen top,
        // which for a scrolled-off frame is the same thing.
        this.row = Math.max(0, this.row - num(1));
        return;
      case "B":
        this.row += num(1);
        this.rowAt(this.row);
        return;
      case "C":
        this.col += num(1);
        return;
      case "D":
        this.col = Math.max(0, this.col - num(1));
        return;
      case "G":
        this.col = Math.max(0, num(1) - 1);
        return;
      case "H":
      case "f": {
        // Row is addressed within the hot window (the "screen" this emulator
        // knows about).
        const [r, c] = body.split(";").map((x) => parseInt(x, 10));
        this.row = Math.max(0, (Number.isNaN(r) ? 1 : r) - 1);
        this.col = Math.max(0, (Number.isNaN(c) ? 1 : c) - 1);
        this.rowAt(this.row);
        return;
      }
      case "K": {
        const h = this.rowAt(this.row);
        const mode = num(0);
        if (mode === 0) this.truncateRow(h, this.col);
        else if (mode === 1) this.blankCells(h, 0, this.col);
        else if (mode === 2) this.blankRow(h);
        return;
      }
      case "J": {
        const h = this.rowAt(this.row);
        const mode = num(0);
        if (mode === 0) {
          // Cursor → end of display: truncate this row, drop rows below.
          this.truncateRow(h, this.col);
          this.hot.length = this.row + 1;
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r++) this.blankRow(this.hot[r]);
          this.blankCells(h, 0, this.col);
        } else {
          // 2 / 3 — the whole display. Only the hot window IS the display
          // here; committed lines are history and stay. Blanked in place
          // rather than removed: the cursor does not move.
          for (const r of this.hot) this.blankRow(r);
        }
        return;
      }
      default:
        // Scroll regions, mode set/reset, etc. — meaningless in block output.
        return;
    }
  }

  // ── Public ───────────────────────────────────────────────────────────────

  /**
   * Feed text. The block parser hands over plain runs (which may carry
   * `\r`, `\n`, `\b`, BEL) and complete CSI sequences; OSC never reaches here.
   */
  push(input: string): void {
    const text = this.pending ? this.pending + input : input;
    this.pending = "";
    const n = text.length;
    if (n === 0) return;
    this.dirty = true;
    let i = 0;
    while (i < n) {
      // Plain run up to the next control character.
      let j = i;
      let c = text.charCodeAt(j);
      while (j < n && c !== ESC && c !== CR && c !== LF && c !== BS && c !== BEL) {
        j++;
        c = text.charCodeAt(j);
      }
      if (j > i) this.putText(text.slice(i, j));
      if (j >= n) break;
      i = j;
      if (c === CR) {
        this.col = 0;
        i++;
      } else if (c === LF) {
        this.row++;
        this.rowAt(this.row);
        this.commitTop();
        i++;
      } else if (c === BS) {
        this.col = Math.max(0, this.col - 1);
        i++;
      } else if (c === BEL) {
        i++;
      } else {
        // ESC
        if (i + 1 >= n) {
          this.pending = text.slice(i);
          return;
        }
        const t = text.charCodeAt(i + 1);
        if (t === 0x5b /* [ */) {
          let k = i + 2;
          let f = text.charCodeAt(k);
          while (k < n && !(f >= 0x40 && f <= 0x7e)) {
            k++;
            f = text.charCodeAt(k);
          }
          if (k >= n) {
            this.pending = text.slice(i);
            return;
          }
          this.csi(text.slice(i + 2, k), text[k]);
          i = k + 1;
        } else {
          i += 2;
        }
      }
    }
  }

  /**
   * Everything renderable right now. Committed lines keep identity; hot rows
   * are flattened into fresh objects (there are at most `hotRows` of them).
   */
  snapshot(): { lines: ResolvedLine[]; dropped: number } {
    this.dirty = false;
    const lines = this.committed.slice();
    for (const h of this.hot) lines.push({ id: h.id, segments: this.flatten(h) });
    return { lines, dropped: this.dropped };
  }

  /**
   * The block finished: freeze every row. Trailing blank rows are trimmed so a
   * block ends on its last real line (the prompt's own newline follows it).
   */
  finish(trimTrailingBlank = true): ResolvedLine[] {
    for (const h of this.hot) this.committed.push({ id: h.id, segments: this.flatten(h) });
    this.hot = [];
    this.dirty = false;
    if (trimTrailingBlank) {
      while (
        this.committed.length > 0 &&
        this.committed[this.committed.length - 1].segments.length === 0
      ) {
        this.committed.pop();
      }
    }
    return this.committed;
  }
}

/** Flatten resolved lines to one segment array with `\n` separators — the
 *  shape the pre-incremental renderer consumed. */
export function linesToSegments(lines: readonly ResolvedLine[]): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  for (let r = 0; r < lines.length; r++) {
    for (const s of lines[r].segments) out.push(s);
    if (r < lines.length - 1) out.push({ text: "\n" });
  }
  return out;
}
