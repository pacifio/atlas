import type { Terminal } from "@xterm/xterm";

/**
 * macOS-style textual navigation + keyboard selection for the terminal.
 *
 * - **Navigation** sends the standard readline/emacs sequences to the shell
 *   (works in zsh/bash default emacs keymap): Option+←/→ jump by word,
 *   Cmd+←/→ to line start/end, Option/Cmd+Backspace delete word/line.
 * - **Selection** (Shift+arrows) drives xterm's own text selection (for
 *   copying) — terminals have no shell-side "selection", so this highlights
 *   buffer cells anchored at the cursor. Single-row (the command line), which
 *   covers the common case.
 *
 * Returns one of:
 *   - a `string` → caller writes it to the PTY (and stops xterm),
 *   - `"handled"` → selection done, stop xterm,
 *   - `null` → not ours; caller continues (copy/paste, normal input).
 */

const WORD = /[A-Za-z0-9_]/;

function prevWordBoundary(text: string, i: number): number {
  let j = i;
  while (j > 0 && !WORD.test(text[j - 1])) j--;
  while (j > 0 && WORD.test(text[j - 1])) j--;
  return j;
}
function nextWordBoundary(text: string, i: number): number {
  let j = i;
  const n = text.length;
  while (j < n && !WORD.test(text[j])) j++;
  while (j < n && WORD.test(text[j])) j++;
  return j;
}

export type KeymapResult = string | "handled" | null;

export function createTerminalKeymap(
  term: Terminal,
): (e: KeyboardEvent) => KeymapResult {
  let sel: { anchor: number; focus: number; row: number } | null = null;

  return (e) => {
    if (e.type !== "keydown") return null;
    const { key, altKey, metaKey, shiftKey, ctrlKey } = e;

    // --- Word / line navigation → readline sequences to the shell ---
    if (!shiftKey && !ctrlKey) {
      if (altKey && key === "ArrowLeft") {
        sel = null;
        return "\x1bb";
      } // backward-word
      if (altKey && key === "ArrowRight") {
        sel = null;
        return "\x1bf";
      } // forward-word
      if (metaKey && key === "ArrowLeft") {
        sel = null;
        return "\x01";
      } // beginning-of-line
      if (metaKey && key === "ArrowRight") {
        sel = null;
        return "\x05";
      } // end-of-line
      if (altKey && key === "Backspace") {
        sel = null;
        return "\x1b\x7f";
      } // backward-kill-word
      if (metaKey && key === "Backspace") {
        sel = null;
        return "\x15";
      } // kill line to start
    }

    // --- Keyboard selection (Shift+←/→, +Option=word, +Cmd=line) ---
    if (shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      const buf = term.buffer.active;
      const row = buf.baseY + buf.cursorY;
      if (!sel || sel.row !== row)
        sel = { anchor: buf.cursorX, focus: buf.cursorX, row };
      const text = buf.getLine(row)?.translateToString(true) ?? "";
      const eol = text.replace(/\s+$/, "").length;
      if (key === "ArrowLeft") {
        sel.focus = metaKey
          ? 0
          : altKey
            ? prevWordBoundary(text, sel.focus)
            : Math.max(0, sel.focus - 1);
      } else {
        sel.focus = metaKey
          ? eol
          : altKey
            ? nextWordBoundary(text, sel.focus)
            : Math.min(eol, sel.focus + 1);
      }
      const start = Math.min(sel.anchor, sel.focus);
      const len = Math.abs(sel.anchor - sel.focus);
      if (len > 0) term.select(start, row, len);
      else term.clearSelection();
      return "handled";
    }

    // Any other key ends keyboard-selection tracking (the visible xterm
    // selection persists for ⌘C until xterm itself clears it).
    sel = null;
    return null;
  };
}
