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

export interface TerminalBlock {
  id: number;
  command: string;
  cwd: string;
  /** Raw output (with SGR) between OSC 133 C and D. */
  output: string;
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
  /** Bumped on every mutation of this block. Block objects are mutated in
   *  place while running, so React memoization keys on `(block, rev)` — a
   *  finished block's rev never changes and its card never re-renders. */
  rev: number;
}

const ESC = 0x1b;

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
// Once a block has emitted this much, treat it as a "firehose": stop rendering
// every batch (throttle to FIREHOSE_FLUSH_MS) so the UI thread stays free.
const FIREHOSE_BYTES = 256 * 1024;
const FIREHOSE_FLUSH_MS = 1500;
const NORMAL_FLUSH_MS = 16;
// Keep at most this many blocks mounted. Every block stays in the DOM (the
// list isn't virtualized), so an unbounded history grows node count — and
// per-flush reconciliation work — forever in a long-lived session.
const MAX_BLOCKS = 200;

// Matches the tail of common password / passphrase prompts:
//   "[sudo] password for user:"  "Password:"  "user@host's password:"
//   "Enter passphrase for key …:"
const PW_PROMPT_RE =
  /(?:password(?: for [^:\n]*)?|passphrase[^:\n]*|'s password)\s*:[ \t]*$/i;

/** Whether the output's last line looks like a password prompt. Strips OSC/CSI
 *  so a colour-styled prompt still matches. */
function looksLikePasswordPrompt(output: string): boolean {
  const plain = output
    // OSC … BEL/ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI …
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
  private current: TerminalBlock | null = null;
  private preambleId = 0;
  private integrated = false;
  // Render coalescing: pushes mark dirty and schedule a single flush instead of
  // calling onChange synchronously per batch. A firehose block flushes slowly.
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private forceFlush = false;
  private bytesInBlock = 0;

  /** Live working directory (OSC 7), surfaced for the input-area badge. */
  get currentCwd(): string {
    return this.cwd;
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
    this.bytesInBlock = 0;
    this.mode = "prompt";
    this.flushNow();
  }

  /** Coalesce renders. The current block's volume decides the cadence: a
   *  firehose throttles to FIREHOSE_FLUSH_MS so the UI thread stays responsive
   *  during a huge dump; normal output flushes next frame. */
  private scheduleFlush(): void {
    if (this.forceFlush) {
      this.flushNow();
      return;
    }
    if (this.flushTimer != null) return;
    const delay = this.current?.firehose ? FIREHOSE_FLUSH_MS : NORMAL_FLUSH_MS;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.onChange();
    }, delay);
  }

  /** Flush immediately (command finished / cleared) — bypasses throttling. */
  private flushNow(): void {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.forceFlush = false;
    this.onChange();
  }

  constructor(
    initialCwd: string,
    private onChange: () => void,
  ) {
    this.cwd = initialCwd;
    // Preamble block: the shell banner / output before the first prompt marker.
    // If shell integration ISN'T active (no OSC 133 ever), EVERYTHING stays
    // here — the terminal degrades to a single continuous output block.
    this.current = {
      id: this.nextId++,
      command: "",
      cwd: initialCwd,
      output: "",
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

    const appendOut = (chunk: string) => {
      if (this.mode === "output" && this.current) {
        this.current.output += chunk;
        this.current.rev++;
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
      if (ch !== ESC) {
        // Plain run up to the next ESC.
        let j = i + 1;
        while (j < n && s.charCodeAt(j) !== ESC) j++;
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
        if (body === "?1049" && s[j] === "h") {
          this.altScreen = true;
          changed = true;
        } else if (body === "?1049" && s[j] === "l") {
          this.altScreen = false;
          changed = true;
        } else appendOut(seq); // keep SGR / other CSI in the block output
        i = j + 1;
        continue;
      }

      // Other escapes (charset designation ESC( / ESC) , single ST, etc.)
      if (t === "(" || t === ")") {
        if (i + 2 >= n) break;
        i += 3;
        continue;
      }
      // Lone ESC + one byte.
      i += 2;
    }

    // Re-evaluate whether the live command is prompting for a secret. Only the
    // running block can be awaiting input; recomputed each push so the inline
    // field appears on "Password:" and disappears once other output follows.
    // Skip firehose blocks (a huge dump isn't a prompt) and scan only the tail
    // so the regex stays cheap even on a large block.
    if (
      this.current &&
      this.current.running &&
      this.mode === "output" &&
      !this.current.firehose
    ) {
      const out = this.current.output;
      const tail = out.length > 256 ? out.slice(-256) : out;
      const next = looksLikePasswordPrompt(tail);
      if (next !== !!this.current.awaitingPassword) {
        this.current.awaitingPassword = next;
        this.current.rev++;
        changed = true;
      }
    }

    this.pending = s.slice(i);
    if (changed) this.scheduleFlush();
  }

  private handleOsc(body: string): boolean {
    // OSC 7 — working directory: "7;file://host/abs/path"
    if (body.startsWith("7;")) {
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
        this.current = {
          id: this.nextId++,
          command: this.pendingCommand.trim(),
          cwd: this.cwd,
          output: "",
          exitCode: null,
          running: true,
          startedAt: Date.now(),
          endedAt: null,
          rev: 0,
        };
        this.pendingCommand = "";
        this.bytesInBlock = 0;
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
          // Trim trailing blank lines for a compact block (the `%` partial-line
          // mark itself is suppressed at the source via `unsetopt PROMPT_SP`).
          this.current.output = this.current.output.replace(/[\r\n]+$/, "");
          // The preamble block (no command) carries no meaningful exit code.
          this.current.exitCode =
            this.current.command === "" || Number.isNaN(code) ? null : code;
          // Replace with a new object so React sees the change.
          this.blocks = this.blocks.map((b) =>
            b.id === this.current!.id ? { ...this.current! } : b,
          );
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
