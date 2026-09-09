/**
 * Stateful parser that turns the raw PTY byte stream into command
 * "blocks", using the shell-integration markers our zsh hook emits:
 *   OSC 133 ; A            prompt drawn        (→ enter "prompt" mode, discard)
 *   OSC 6973 ; C ; <cmd>   command text        (preexec)
 *   OSC 133 ; C            output begins        (→ start a block, "output" mode)
 *   OSC 133 ; D ; <exit>   command ended        (→ finalize, exit code)
 *   OSC 7 ; file://host<p> working directory
 *   CSI ? 1049 h / l       alt-screen enter/leave (interactive app → xterm)
 *
 * Between A and C (the prompt + the echoed command) is discarded — the command
 * itself shows in the block header (from OSC 6973). Between C and D is the
 * block's raw output (SGR preserved for `ansiToSegments`). Bytes still go to a
 * hidden xterm in parallel (the interactive surface); this only builds the
 * history view.
 */

import { LineEmulator, type ResolvedLine } from "./line-emulator";

/**
 * Lifecycle events, emitted SYNCHRONOUSLY as the parser sees the markers (not
 * through the coalesced render flush). The notifier hangs off these; so could
 * anything else that cares when a command starts or ends.
 */
export type TerminalEvent =
  | {
      type: "commandStarted";
      blockId: number;
      command: string;
      cwd: string;
      startedAt: number;
    }
  | {
      type: "commandFinished";
      blockId: number;
      command: string;
      cwd: string;
      exitCode: number | null;
      startedAt: number;
      endedAt: number;
      durationMs: number;
      /** The command took the alternate screen at some point (vim, htop…). */
      usedAltScreen: boolean;
    }
  | {
      type: "attention";
      kind: "password" | "bell" | "notify" | "prompt";
      blockId: number | null;
      command: string;
      title?: string;
      body?: string;
    }
  | { type: "altScreenEnter" }
  | { type: "altScreenLeave" };

export type TerminalEventSink = (event: TerminalEvent) => void;

export interface TerminalBlock {
  id: number;
  command: string;
  cwd: string;
  /** Raw output (with SGR) between OSC 133 C and D. Kept for Copy; the
   *  rendered view reads `lines`. */
  output: string;
  /** Resolved, styled lines — the incremental emulator's view of `output`.
   *  Committed lines keep object identity across flushes; only the hot tail
   *  (rows the cursor can still reach) is rebuilt per flush. */
  lines: readonly ResolvedLine[];
  /** Lines dropped from the front of `lines` to bound memory. */
  droppedLines: number;
  exitCode: number | null;
  running: boolean;
  startedAt: number;
  endedAt: number | null;
  /** The running command is waiting for a secret (heuristic on the output tail).
   *  Drives an inline masked input inside the block — see BlockCard. */
  awaitingPassword?: boolean;
  /** Stored output was trimmed from the front (very large output). */
  truncated?: boolean;
  /** This block emitted a high volume of output, so live rendering is throttled
   *  (the "large output" badge). */
  firehose?: boolean;
  /** The command entered the alternate screen at least once. */
  usedAltScreen?: boolean;
  /** Bumped on every mutation of this block. Block objects are mutated in
   *  place while running, so React memoization keys on `(block, rev)` — a
   *  finished block's rev never changes and its card never re-renders. */
  rev: number;
}

const ESC = 0x1b;
const BEL_CODE = 0x07;

// Bound a single block's stored output so a huge dump (e.g. `tree /`, 100k+
// lines) can't grow the string to hundreds of MB — that alone froze the app
// (O(n) string append per 16ms batch → O(n²), plus re-segmenting the whole
// thing every frame). We keep the most recent `OUTPUT_STORE_CAP` bytes.
// 2 MB (up from 512 KB — "long content gets cut off"): Copy and the render
// tail both reach further back, and the trim is now amortized (see SLACK).
const OUTPUT_STORE_CAP = 2 * 1024 * 1024;
// Only trim once the string is this far past the cap. Trimming exactly at the
// cap meant a full `slice` copy of the whole capped string on nearly every
// 16 ms batch once a block crossed it — O(n²) over a long stream. With slack,
// each trim pays one copy per SLACK bytes appended.
const OUTPUT_TRIM_SLACK = 256 * 1024;
// Once a block has emitted this much it is a "firehose": the card shows a
// badge and the password heuristic (a regex over the tail) is skipped. The
// render cadence is no longer throttled by this — the incremental emulator
// made a flush cheap and the rAF drain bounds per-frame work.
const FIREHOSE_BYTES = 256 * 1024;
// Late backstop for a parser nobody drains — see `scheduleFlush`.
const BACKSTOP_FLUSH_MS = 100;
// Keep at most this many blocks mounted. Every block stays in the DOM (the
// list isn't virtualized), so an unbounded history grows node count — and
// per-flush reconciliation work — forever in a long-lived session.
const MAX_BLOCKS = 200;
// Resolved lines kept per block. Beyond this the emulator drops from the front
// and the card says so; Copy still has `output` (up to OUTPUT_STORE_CAP).
const MAX_LINES = 5000;
// Rows the cursor can still redraw. Floored so prompt libraries that draw
// frames taller than a short pane still get their whole frame back.
const MIN_HOT_ROWS = 64;

// Matches the tail of common password / passphrase prompts:
//   "[sudo] password for user:"  "Password:"  "user@host's password:"
//   "Enter passphrase for key …:"
const PW_PROMPT_RE = /(?:password(?: for [^:\n]*)?|passphrase[^:\n]*|'s password)\s*:[ \t]*$/i;

/** Whether the output's last line looks like a password prompt. Strips OSC/CSI
 *  so a colour-styled prompt still matches. */
function looksLikePasswordPrompt(output: string): boolean {
  const plain = output
    // OSC … BEL/ST
    // oxlint-disable-next-line no-control-regex -- intentionally matching ANSI control bytes
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI …
    // oxlint-disable-next-line no-control-regex -- intentionally matching ANSI control bytes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const trimmed = plain.replace(/[ \t\r]+$/, "");
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  return PW_PROMPT_RE.test(lastLine);
}

export class BlockStreamParser {
  private pending = "";
  private mode: "prompt" | "output" = "prompt";
  private pendingCommand = "";
  private cwd = "";
  private nextId = 1;
  blocks: TerminalBlock[] = [];
  altScreen = false;
  /** DECCKM — application cursor keys. Decides how arrows must be ENCODED when
   *  we forward them: `CSI A` normally, `SS3 A` once an app has enabled this.
   *  Prompts that turn it on ignore the CSI form entirely. */
  appCursorKeys = false;
  private current: TerminalBlock | null = null;
  /** The live block's emulator. Created with the block, finished with it. */
  private emu: LineEmulator | null = null;
  private rows = 24;
  private preambleId = 0;
  private integrated = false;

  /** Whether the shell has drawn a prompt through OSC 133.
   *
   *  The one honest "the shell is ready for input" signal available: the marker
   *  is emitted by the integration rc AFTER the user's own profile has been
   *  sourced. Anything sent before it races whatever the profile is doing, and
   *  a profile that reads stdin or calls `stty` will swallow it. Always false
   *  for a shell with no integration (anything but zsh here), so a caller must
   *  have a fallback rather than waiting forever. */
  get hasDrawnPrompt(): boolean {
    return this.integrated;
  }
  // Render coalescing: pushes mark dirty and schedule a single flush instead of
  // calling onChange synchronously per batch. A firehose block flushes slowly.
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private forceFlush = false;
  private bytesInBlock = 0;

  /** Live working directory (OSC 7), surfaced for the input-area badge. */
  get currentCwd(): string {
    return this.cwd;
  }

  /** PTY height — sizes the emulator's hot window for the NEXT block. */
  setRows(rows: number): void {
    if (rows > 0) this.rows = rows;
  }

  private newEmulator(): LineEmulator {
    return new LineEmulator({ hotRows: Math.max(this.rows, MIN_HOT_ROWS), maxLines: MAX_LINES });
  }

  /** Publish the emulator's current lines onto the live block. Called once per
   *  flush, not per push — that is the whole point of `rev` moving here. */
  private syncLive(): void {
    if (this.current && this.emu && this.emu.isDirty) {
      const snap = this.emu.snapshot();
      this.current.lines = snap.lines;
      this.current.droppedLines = snap.dropped;
      this.current.rev++;
    }
  }

  /** Whether a command is currently executing (the live block is running). */
  get busy(): boolean {
    const last = this.blocks[this.blocks.length - 1];
    return !!last && last.running && last.command !== "";
  }

  /** Drop the rendered command blocks (the `clear` builtin). Keeps cwd / mode /
   *  shell-integration state so the next prompt continues cleanly. */
  clearBlocks(): void {
    this.blocks = [];
    this.current = null;
    this.emu = null;
    this.bytesInBlock = 0;
    this.mode = "prompt";
    this.flushNow();
  }

  /** Coalesce renders.
   *
   *  The consumer drives the cadence: the block terminal's rAF drain calls
   *  `flushNow()` once per frame after feeding every chunk it consumed, so a
   *  push only marks the parser dirty. The timer here is a BACKSTOP for callers
   *  that push without draining (tests, a consumer without a frame loop) — it
   *  fires late on purpose so it never races the frame-aligned flush. A finished
   *  block (`forceFlush`) still renders immediately. */
  private scheduleFlush(): void {
    if (this.forceFlush) {
      this.flushNow();
      return;
    }
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.syncLive();
      this.onChange();
    }, BACKSTOP_FLUSH_MS);
  }

  /** Flush immediately (command finished / cleared) — bypasses throttling. */
  flushNow(): void {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.forceFlush = false;
    this.syncLive();
    this.onChange();
  }

  /**
   * Bytes for the interactive xterm surface.
   *
   * xterm used to receive EVERY byte in parallel with this parser, parsing a
   * 50 MB `cat` into a surface nobody could see. It now receives only what it
   * needs to be correct the moment an app takes the screen: while in the
   * normal screen, the mode-affecting sequences an app expects to still be in
   * force (DECSET/DECRST — cursor keys, mouse, bracketed paste, autowrap,
   * cursor visibility — plus charset designations, scroll region, save/restore
   * cursor and keypad mode); while in the alt screen, everything verbatim.
   * The `?1049h` that enters the alt screen is itself forwarded, so xterm's
   * own save/restore bookkeeping stays consistent.
   */
  private xtermSink: ((text: string) => void) | null = null;

  setXtermSink(sink: ((text: string) => void) | null): void {
    this.xtermSink = sink;
  }

  private emit(event: TerminalEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (e) {
      // A sink bug must never break parsing.
      console.warn("terminal event sink failed:", e);
    }
  }

  constructor(
    initialCwd: string,
    private onChange: () => void,
    private onEvent?: TerminalEventSink,
  ) {
    this.cwd = initialCwd;
    // Preamble block: the shell banner / output before the first prompt marker.
    // If shell integration ISN'T active (no OSC 133 ever), EVERYTHING stays
    // here — the terminal degrades to a single continuous output block.
    this.emu = this.newEmulator();
    this.current = {
      id: this.nextId++,
      command: "",
      cwd: initialCwd,
      output: "",
      lines: [],
      droppedLines: 0,
      exitCode: null,
      running: true,
      startedAt: Date.now(),
      endedAt: null,
      rev: 0,
    };
    this.blocks = [this.current];
    this.preambleId = this.current.id;
    this.mode = "output";
  }

  /** Feed decoded text (caller decodes bytes with a streaming TextDecoder). */
  push(text: string): void {
    this.pending += text;
    let changed = false;
    let i = 0;
    const s = this.pending;
    const n = s.length;
    // Everything consumed from `forwardFrom` onward goes to xterm verbatim
    // (alt-screen mode). Null while in the normal screen.
    let forwardFrom: number | null = this.altScreen ? 0 : null;
    const forwardModeSeq = (seq: string) => {
      if (forwardFrom === null) this.xtermSink?.(seq);
    };

    const appendOut = (chunk: string) => {
      // While an alt-screen app owns the surface its redraw bytes are xterm's
      // business, not the block's: appending them re-emulated vim's whole
      // screen into the block every flush and left garbage in the finished
      // block.
      if (this.mode === "output" && this.current && !this.altScreen) {
        this.current.output += chunk;
        this.emu?.push(chunk);
        this.bytesInBlock += chunk.length;
        // Bound stored output so a giant dump can't grow the string unbounded
        // (and re-segment quadratically). Trim from the front past the cap.
        if (this.current.output.length > OUTPUT_STORE_CAP + OUTPUT_TRIM_SLACK) {
          this.current.output = this.current.output.slice(-OUTPUT_STORE_CAP);
          this.current.truncated = true;
        }
        // Flip to throttled rendering once the block crosses the firehose mark.
        if (!this.current.firehose && this.bytesInBlock > FIREHOSE_BYTES) {
          this.current.firehose = true;
        }
        changed = true;
      }
    };

    while (i < n) {
      const ch = s.charCodeAt(i);
      if (ch === BEL_CODE) {
        // A standalone bell (an OSC terminator is consumed by the OSC branch
        // below and never lands here). Dropped from the stored output — it
        // renders as nothing — and reported as attention while a command is
        // running. A bell at the prompt is zsh's completion beep: ignored.
        if (this.mode === "output" && this.current?.command && !this.altScreen) {
          this.emit({
            type: "attention",
            kind: "bell",
            blockId: this.current.id,
            command: this.current.command,
          });
        }
        i++;
        continue;
      }
      if (ch !== ESC) {
        // Plain run up to the next ESC or bell.
        let j = i + 1;
        let c = s.charCodeAt(j);
        while (j < n && c !== ESC && c !== BEL_CODE) {
          j++;
          c = s.charCodeAt(j);
        }
        appendOut(s.slice(i, j));
        i = j;
        continue;
      }

      // ESC — need at least 2 chars to know the type.
      if (i + 1 >= n) break; // incomplete; wait for more
      const t = s[i + 1];

      if (t === "]") {
        // OSC — terminated by BEL (0x07) or ST (ESC \).
        let j = i + 2;
        let term = -1;
        let termLen = 0;
        while (j < n) {
          if (s.charCodeAt(j) === 0x07) {
            term = j;
            termLen = 1;
            break;
          }
          if (s.charCodeAt(j) === ESC && s[j + 1] === "\\") {
            term = j;
            termLen = 2;
            break;
          }
          j++;
        }
        if (term === -1) break; // incomplete OSC; wait
        const body = s.slice(i + 2, term);
        if (this.handleOsc(body)) changed = true;
        i = term + termLen;
        continue;
      }

      if (t === "[") {
        // CSI — final byte in @-~.
        let j = i + 2;
        while (j < n && !/[@-~]/.test(s[j])) j++;
        if (j >= n) break; // incomplete CSI; wait
        const seq = s.slice(i, j + 1);
        const body = s.slice(i + 2, j);
        const fin = s[j];
        if (body === "?1049" && fin === "h") {
          if (!this.altScreen) {
            this.altScreen = true;
            changed = true;
            if (this.current?.running) this.current.usedAltScreen = true;
            this.emit({ type: "altScreenEnter" });
            // From this sequence on, xterm owns the screen.
            if (forwardFrom === null) forwardFrom = i;
          }
        } else if (body === "?1049" && fin === "l") {
          if (this.altScreen) {
            this.altScreen = false;
            changed = true;
            this.emit({ type: "altScreenLeave" });
            // Forward through the end of the leave sequence, then stop.
            if (forwardFrom !== null) {
              this.xtermSink?.(s.slice(forwardFrom, j + 1));
              forwardFrom = null;
            }
          }
        } else if (body === "?1" && (fin === "h" || fin === "l")) {
          this.appCursorKeys = fin === "h";
          changed = true;
          forwardModeSeq(seq);
        } else {
          // Private modes (`?…h/l`), scroll region (`r`), keypad/cursor state
          // travel to xterm even in the normal screen — an app entering the
          // alt screen relies on them being set already.
          if (body.startsWith("?") && (fin === "h" || fin === "l")) forwardModeSeq(seq);
          else if (fin === "r") forwardModeSeq(seq);
          appendOut(seq); // keep SGR / other CSI in the block output
        }
        i = j + 1;
        continue;
      }

      // Other escapes (charset designation ESC( / ESC) , single ST, etc.)
      if (t === "(" || t === ")") {
        if (i + 2 >= n) break;
        forwardModeSeq(s.slice(i, i + 3));
        i += 3;
        continue;
      }
      // Lone ESC + one byte. Save/restore cursor and keypad mode matter to a
      // full-screen app that is about to start; the rest do not.
      if (t === "7" || t === "8" || t === "=" || t === ">") forwardModeSeq(s.slice(i, i + 2));
      i += 2;
    }

    // Alt-screen bytes consumed this push go to xterm verbatim. Only COMPLETE
    // sequences are forwarded: `pending` (the unconsumed tail) rides along
    // with the next push, exactly as it does for the block path.
    if (forwardFrom !== null && i > forwardFrom) this.xtermSink?.(s.slice(forwardFrom, i));

    // Re-evaluate whether the live command is prompting for a secret. Only the
    // running block can be awaiting input; recomputed each push so the inline
    // field appears on "Password:" and disappears once other output follows.
    // Skip firehose blocks (a huge dump isn't a prompt) and scan only the tail
    // so the regex stays cheap even on a large block.
    if (this.current && this.current.running && this.mode === "output" && !this.current.firehose) {
      const out = this.current.output;
      const tail = out.length > 256 ? out.slice(-256) : out;
      const next = looksLikePasswordPrompt(tail);
      if (next !== !!this.current.awaitingPassword) {
        this.current.awaitingPassword = next;
        this.current.rev++;
        changed = true;
        if (next) {
          this.emit({
            type: "attention",
            kind: "password",
            blockId: this.current.id,
            command: this.current.command,
          });
        }
      }
    }

    this.pending = s.slice(i);
    if (changed) this.scheduleFlush();
  }

  private handleOsc(body: string): boolean {
    // OSC 7 — working directory: "7;file://host/abs/path"
    if (body.startsWith("7;")) {
      // oxlint-disable-next-line no-control-regex -- intentionally matching the OSC 7 terminator byte
      const m = body.match(/file:\/\/[^/]*(\/[^\x07]*)/);
      if (m) {
        const next = decodeURIComponent(m[1]);
        if (next !== this.cwd) {
          this.cwd = next;
          // Trigger a render so the input-area cwd/git badge tracks `cd`.
          return true;
        }
      }
      return false;
    }
    // OSC 9 — iTerm2 / ConEmu "notify": "9;<message>". ConEmu's progress form
    // ("9;4;1;50") is numeric and not a message; skip it.
    if (body.startsWith("9;")) {
      const msg = body.slice(2);
      if (msg && !/^\d+;/.test(msg) && this.current?.command) {
        this.emit({
          type: "attention",
          kind: "notify",
          blockId: this.current.id,
          command: this.current.command,
          body: msg,
        });
      }
      return false;
    }
    // OSC 777 — rxvt-unicode "notify;<title>;<body>".
    if (body.startsWith("777;notify;")) {
      const rest = body.slice("777;notify;".length);
      const sep = rest.indexOf(";");
      const title = sep >= 0 ? rest.slice(0, sep) : rest;
      const text = sep >= 0 ? rest.slice(sep + 1) : "";
      if (this.current?.command) {
        this.emit({
          type: "attention",
          kind: "notify",
          blockId: this.current.id,
          command: this.current.command,
          title,
          body: text,
        });
      }
      return false;
    }
    // OSC 6973 — Atlas command text: "6973;C;<command>"
    if (body.startsWith("6973;C;")) {
      this.pendingCommand = body.slice("6973;C;".length);
      return false;
    }
    // OSC 133 — semantic prompt markers.
    if (body.startsWith("133;")) {
      const part = body.slice(4);
      const kind = part[0];
      if (kind === "A") {
        // First prompt marker → shell integration is live. Drop the preamble
        // block (the shell's startup banner / the bare `%` prompt) so the
        // terminal starts clean instead of with an empty "%" block.
        if (!this.integrated) {
          this.integrated = true;
          this.blocks = this.blocks.filter((b) => b.id !== this.preambleId);
          if (this.current?.id === this.preambleId) this.current = null;
          this.mode = "prompt";
          return true;
        }
        this.mode = "prompt";
      } else if (kind === "C") {
        // Output begins — open a new block.
        this.emu = this.newEmulator();
        this.current = {
          id: this.nextId++,
          command: this.pendingCommand.trim(),
          cwd: this.cwd,
          output: "",
          lines: [],
          droppedLines: 0,
          exitCode: null,
          running: true,
          startedAt: Date.now(),
          endedAt: null,
          rev: 0,
        };
        this.pendingCommand = "";
        this.bytesInBlock = 0;
        if (this.current.command) {
          this.emit({
            type: "commandStarted",
            blockId: this.current.id,
            command: this.current.command,
            cwd: this.current.cwd,
            startedAt: this.current.startedAt,
          });
        }
        this.blocks = [...this.blocks, this.current];
        if (this.blocks.length > MAX_BLOCKS) {
          this.blocks = this.blocks.slice(-MAX_BLOCKS);
        }
        this.mode = "output";
        return true;
      } else if (kind === "D") {
        const code = parseInt(part.split(";")[1] ?? "", 10);
        if (this.current) {
          this.current.running = false;
          this.current.awaitingPassword = false;
          this.current.endedAt = Date.now();
          this.current.rev++;
          // Freeze the lines (trailing blank rows trimmed for a compact block —
          // the `%` partial-line mark itself is suppressed at the source via
          // `unsetopt PROMPT_SP`).
          if (this.emu) {
            this.current.lines = this.emu.finish();
            this.current.droppedLines = this.emu.droppedLines;
            this.emu = null;
          }
          // The preamble block (no command) carries no meaningful exit code.
          this.current.exitCode = this.current.command === "" || Number.isNaN(code) ? null : code;
          // Replace with a new object so React sees the change.
          this.blocks = this.blocks.map((b) =>
            b.id === this.current!.id ? { ...this.current! } : b,
          );
          if (this.current.command) {
            const c = this.current;
            this.emit({
              type: "commandFinished",
              blockId: c.id,
              command: c.command,
              cwd: c.cwd,
              exitCode: c.exitCode,
              startedAt: c.startedAt,
              endedAt: c.endedAt ?? Date.now(),
              durationMs: (c.endedAt ?? Date.now()) - c.startedAt,
              usedAltScreen: !!c.usedAltScreen,
            });
          }
        }
        this.current = null;
        this.mode = "prompt";
        // Render the finished block immediately, bypassing firehose throttling.
        this.forceFlush = true;
        return true;
      }
    }
    return false;
  }
}
