/**
 * Shell integration, read off the terminal's OSC stream.
 *
 * The terminal is a plain xterm: bytes go straight in, keystrokes straight
 * out. What Atlas still wants to KNOW about the shell (is a command running,
 * which one, did it fail, is it asking for a password) comes from the markers
 * our zsh integration emits (`crates/atlas-terminal`), which xterm hands to
 * this tracker through its OSC handlers:
 *   OSC 133 ; A            prompt drawn
 *   OSC 6973 ; C ; <cmd>   command text        (preexec)
 *   OSC 133 ; C            output begins       → commandStarted
 *   OSC 133 ; D ; <exit>   command ended       → commandFinished
 *   OSC 7 ; file://host<p> working directory
 *   OSC 9 ; <msg>, OSC 777 ; notify ; <t> ; <b>   → attention "notify"
 * plus the bell and the alternate screen, which xterm reports directly.
 *
 * Pure: no xterm, no stores. `terminal-session.ts` wires it to a Terminal and
 * the notifier hangs off its events. A shell with no integration (anything
 * but zsh) emits none of this; the terminal still works, it just never says
 * "busy" or notifies.
 */

/**
 * Lifecycle events, emitted synchronously as the markers are parsed. The
 * notifier hangs off these; so could anything else that cares when a command
 * starts or ends.
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
    };

export type TerminalEventSink = (event: TerminalEvent) => void;

// Matches the tail of common password / passphrase prompts:
//   "[sudo] password for user:"  "Password:"  "user@host's password:"
//   "Enter passphrase for key …:"
const PW_PROMPT_RE = /(?:password(?: for [^:\n]*)?|passphrase[^:\n]*|'s password)\s*:[ \t]*$/i;

/** Whether one line of screen text (the cursor's) is a password prompt. */
export function looksLikePasswordPrompt(line: string): boolean {
  return PW_PROMPT_RE.test(line.replace(/[ \t\r]+$/, ""));
}

interface Running {
  id: number;
  command: string;
  cwd: string;
  startedAt: number;
  usedAltScreen: boolean;
  askedPassword: boolean;
}

export class ShellIntegration {
  private nextId = 1;
  private pendingCommand = "";
  private running: Running | null = null;
  private altScreen = false;
  private prompted = false;
  cwd: string;

  constructor(
    cwd: string,
    private readonly emit: TerminalEventSink,
    /** Something a view shows changed: the cwd, or the running command. */
    private readonly onChange: () => void,
  ) {
    this.cwd = cwd;
  }

  /** The shell has drawn a prompt through OSC 133 — it is ready for input.
   *  Always false for a shell with no integration, so a caller waiting on it
   *  needs a fallback. */
  get hasDrawnPrompt(): boolean {
    return this.prompted;
  }

  /** The foreground command, while one runs. */
  get command(): string | null {
    return this.running?.command || null;
  }

  /** OSC 133 (semantic prompt). Returns true: the sequence is consumed. */
  osc133(data: string): boolean {
    const kind = data[0];
    if (kind === "A") {
      this.prompted = true;
    } else if (kind === "C") {
      this.running = {
        id: this.nextId++,
        command: this.pendingCommand.trim(),
        cwd: this.cwd,
        startedAt: Date.now(),
        usedAltScreen: this.altScreen,
        askedPassword: false,
      };
      this.pendingCommand = "";
      const r = this.running;
      if (r.command) {
        this.emit({
          type: "commandStarted",
          blockId: r.id,
          command: r.command,
          cwd: r.cwd,
          startedAt: r.startedAt,
        });
      }
      this.onChange();
    } else if (kind === "D") {
      const r = this.running;
      this.running = null;
      if (r) {
        const code = parseInt(data.split(";")[1] ?? "", 10);
        const endedAt = Date.now();
        if (r.command) {
          this.emit({
            type: "commandFinished",
            blockId: r.id,
            command: r.command,
            cwd: r.cwd,
            exitCode: Number.isNaN(code) ? null : code,
            startedAt: r.startedAt,
            endedAt,
            durationMs: endedAt - r.startedAt,
            usedAltScreen: r.usedAltScreen,
          });
        }
        this.onChange();
      }
    }
    return true;
  }

  /** OSC 6973 — Atlas's command text: "C;<command>". */
  osc6973(data: string): boolean {
    if (data.startsWith("C;")) this.pendingCommand = data.slice(2);
    return true;
  }

  /** OSC 7 — working directory: "file://host/abs/path". */
  osc7(data: string): boolean {
    const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
    if (m) {
      let next = m[1];
      try {
        next = decodeURIComponent(next);
      } catch {
        /* keep it raw */
      }
      if (next !== this.cwd) {
        this.cwd = next;
        this.onChange();
      }
    }
    return true;
  }

  /** OSC 9 — iTerm2 / ConEmu notify: "<message>". ConEmu's progress form
   *  ("4;1;50") is numeric and not a message. */
  osc9(data: string): boolean {
    const r = this.running;
    if (data && !/^\d+;/.test(data) && r?.command) {
      this.emit({
        type: "attention",
        kind: "notify",
        blockId: r.id,
        command: r.command,
        body: data,
      });
    }
    return true;
  }

  /** OSC 777 — rxvt-unicode "notify;<title>;<body>". */
  osc777(data: string): boolean {
    const r = this.running;
    if (!data.startsWith("notify;") || !r?.command) return true;
    const rest = data.slice("notify;".length);
    const sep = rest.indexOf(";");
    this.emit({
      type: "attention",
      kind: "notify",
      blockId: r.id,
      command: r.command,
      title: sep >= 0 ? rest.slice(0, sep) : rest,
      body: sep >= 0 ? rest.slice(sep + 1) : "",
    });
    return true;
  }

  /** A bell. At the prompt it is zsh's completion beep, and inside a
   *  full-screen app it is the app's business: only a running command's bell
   *  asks for attention. */
  bell(): void {
    const r = this.running;
    if (!r?.command || this.altScreen) return;
    this.emit({ type: "attention", kind: "bell", blockId: r.id, command: r.command });
  }

  /** The alternate screen was entered or left (vim, htop…). */
  setAltScreen(on: boolean): void {
    this.altScreen = on;
    if (on && this.running) this.running.usedAltScreen = true;
  }

  /** After output lands: is the running command now asking for a secret?
   *  Reported when the prompt appears, and again only after other output has
   *  replaced it (a "Sorry, try again" re-prompt). */
  checkPasswordPrompt(cursorLine: string): void {
    const r = this.running;
    if (!r?.command || this.altScreen) return;
    const asking = looksLikePasswordPrompt(cursorLine);
    if (asking === r.askedPassword) return;
    r.askedPassword = asking;
    if (asking) {
      this.emit({ type: "attention", kind: "password", blockId: r.id, command: r.command });
    }
  }
}
