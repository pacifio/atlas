// A PTY that never existed.
//
// The terminal is the one heavy subsystem that renders honestly in a browser:
// the block UI is plain DOM over a byte stream, so a scripted stream is
// indistinguishable from a shell as far as everything downstream is concerned.
// That stream has to go where the real one goes — `terminal_create` is handed a
// Tauri `Channel` as `onOutput`, and `mockIPC` passes the live object through
// unserialized, so the fake writes into that same channel rather than inventing
// an event. Nothing in `terminal-session.ts` or `block-parser.ts` is bypassed:
// the credit window, the rAF drain and the OSC-133 block segmentation all run.
//
// Which means the script must speak the shell-integration protocol the parser
// expects (see the header of `block-parser.ts`):
//   OSC 133;A        prompt drawn  — also DROPS the preamble block
//   OSC 6973;C;<cmd> command text  — this is what the block header shows
//   OSC 133;C        output begins
//   OSC 133;D;<code> finished, with the exit code
//   OSC 7;file://…   working directory, for the input-area cwd/git badge
// The banner is therefore emitted as a command-less block rather than before
// the first prompt marker: `133;A` deletes the preamble, so a banner written
// there would vanish the moment the first prompt arrived.
//
// Line breaks are `\r\n`, never `\n`. The emulator moves the cursor DOWN on LF
// and back to column 0 only on CR, exactly like a real tty — a bare `\n` gives
// a descending staircase.
//
// The states worth having on screen, and where each one comes from:
//   running / streaming   `bun run build` (a `\r`-redrawn spinner, ~2s)
//   failed                `bun run test` (non-zero exit, red stderr)
//   cancelled             Ctrl-C into a running command → exit 130
//   killed                the stop control → `terminal_kill_foreground` → 137
//   awaiting a secret     `sudo …` → the inline masked field
//   not found             anything unscripted → exit 127

import type { Channel } from "@tauri-apps/api/core";
import type { RawPathCompletion } from "@/features/terminal/lib/terminal-api";
import type { TypedHandlers, Unread } from "../types";
import { MOCK_PROJECT } from "../project";
import { fileText, listDir, mockFilePaths } from "./files";

// The composer's cwd badge also calls `git_status_fresh`, which is the git
// domain's command and is faked in `fixtures/git.ts` — not here, so the two
// fixtures cannot shadow each other. Unanswered it resolves `null`, the badge's
// `.catch` clears itself, and the terminal is otherwise unaffected.

// ── the wire ──────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Rust sends `InvokeResponseBody::Raw`, so the channel carries an owned
 *  ArrayBuffer — `Uint8Array.buffer` is `ArrayBufferLike`, hence the copy. */
function toBuffer(text: string): ArrayBuffer {
  const bytes = encoder.encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const osc = (body: string) => `\x1b]${body}\x07`;

/** SGR escapes, named. The point of the scripted output is that the theme's
 *  ANSI palette is visible without running anything real. */
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
};

const paint = (colour: string, text: string) => `${colour}${text}${C.reset}`;
/** Erase the whole line and go home — how a spinner redraws in place. */
const REDRAW = "\r\x1b[2K";

// ── sessions ──────────────────────────────────────────────────────────────

interface Running {
  command: string;
  /** The block is showing a password prompt; the next line is the secret. */
  awaitingPassword: boolean;
}

interface FakeSession {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  channel: Channel<ArrayBuffer | number[]>;
  /**
   * The command in flight, or null at the prompt. Object IDENTITY is the
   * cancel token: Ctrl-C clears it, and every chunk still queued behind a
   * timer checks it and drops itself.
   */
  running: Running | null;
  /** Typed bytes not yet terminated by a newline. */
  line: string;
}

const sessions = new Map<string, FakeSession>();
let nextId = 0;

function write(s: FakeSession, text: string): void {
  s.channel.onmessage(toBuffer(text));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setCwd(s: FakeSession, cwd: string): void {
  s.cwd = cwd;
  write(s, osc(`7;file://mock${cwd}`));
}

/** Draw the next prompt. The bytes between A and C are discarded by the
 *  parser (the block header carries the command), so this is state, not text. */
function prompt(s: FakeSession): void {
  write(s, osc("133;A"));
}

function finish(s: FakeSession, code: number): void {
  write(s, osc(`133;D;${code}`));
  s.running = null;
  prompt(s);
}

// ── the fake tree, as the shell sees it ───────────────────────────────────

/** Absolute paths of every seeded file — the shell and the file tree cannot
 *  disagree about what exists, because there is only one list. */
const absPaths = () => mockFilePaths().map((rel) => `${MOCK_PROJECT.path}/${rel}`);

function absDirs(): string[] {
  const dirs = new Set<string>([MOCK_PROJECT.path]);
  for (const rel of mockFilePaths()) {
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      dirs.add(`${MOCK_PROJECT.path}/${parts.slice(0, i).join("/")}`);
    }
  }
  return [...dirs];
}

/** Expand `~`, resolve `.`/`..` and make a token absolute against `base`. */
function resolveAgainst(base: string, token: string): string {
  const raw =
    token === "~" || token.startsWith("~/")
      ? token.replace("~", "/Users/dev")
      : token.startsWith("/")
        ? token
        : `${base}/${token}`;
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** The existing absolute path a token names, or null. Mirrors Rust: a trailing
 *  `:line[:col]` is stripped so a clicked `file.ts:42:8` still resolves. */
function resolvePath(base: string, raw: string): string | null {
  let token = raw.trim().replace(/[.,;)\]"']+$/, "");
  for (let i = 0; i < 2; i++) {
    const at = token.lastIndexOf(":");
    if (at > 0 && /^\d+$/.test(token.slice(at + 1))) token = token.slice(0, at);
    else break;
  }
  if (!token) return null;
  const path = resolveAgainst(base, token);
  if (absPaths().includes(path) || absDirs().includes(path)) return path;
  return null;
}

// ── scripted answers ──────────────────────────────────────────────────────

/** `ls`, coloured the way a real `ls -G` is: directories bold blue, dotfiles
 *  dim. Drawn from the seeded tree, so it never lists a file the editor can't
 *  open. */
function lsOutput(s: FakeSession, argv: string[]): string {
  const target = argv.find((a) => !a.startsWith("-"));
  const dir = target ? resolveAgainst(s.cwd, target) : s.cwd;
  const entries = listDir(dir);
  if (entries.length === 0) {
    return paint(C.red, `ls: ${target ?? dir}: No such file or directory`) + "\r\n";
  }
  const long = argv.some((a) => a.startsWith("-") && a.includes("l"));
  const all = argv.some((a) => a.startsWith("-") && a.includes("a"));
  const visible = entries.filter((e) => all || !e.name.startsWith("."));
  const label = (name: string, isDir: boolean) =>
    isDir ? paint(C.bold + C.blue, name) : name.startsWith(".") ? paint(C.grey, name) : name;
  if (!long) {
    return visible.map((e) => label(e.name, e.is_dir)).join("  ") + "\r\n";
  }
  return (
    visible
      .map((e) => {
        const mode = e.is_dir ? "drwxr-xr-x" : "-rw-r--r--";
        const size = String(e.size).padStart(7, " ");
        return `${paint(C.grey, mode)}  1 dev  staff ${size} 18 Sep 11:30 ${label(e.name, e.is_dir)}`;
      })
      .join("\r\n") + "\r\n"
  );
}

/**
 * `git status`, in git's own colours — staged green, unstaged red. The file
 * list mirrors the working tree in `fixtures/git.ts` so the terminal and the
 * git panel describe the same repository; it is restated rather than imported
 * because that fixture exports handlers, not its change list.
 */
function gitStatusOutput(): string {
  const staged = [
    "modified:   src/styles/tokens.css",
    "modified:   README.md",
    "deleted:    src/legacy/auth.ts",
  ];
  const unstaged = [
    "modified:   public/logo.png",
    "modified:   src-tauri/src/lib.rs",
    "modified:   src/lib/api.ts",
  ];
  return (
    [
      `On branch ${paint(C.green, "main")}`,
      "Your branch and 'origin/main' have diverged,",
      "and have 3 and 1 different commits each, respectively.",
      `  ${paint(C.dim, '(use "git pull" to merge the remote branch into yours)')}`,
      "",
      "Changes to be committed:",
      `  ${paint(C.dim, '(use "git restore --staged <file>..." to unstage)')}`,
      ...staged.map((row) => `        ${paint(C.green, row)}`),
      "",
      "Changes not staged for commit:",
      `  ${paint(C.dim, '(use "git add <file>..." to update what will be committed)')}`,
      ...unstaged.map((row) => `        ${paint(C.red, row)}`),
      "",
      "Untracked files:",
      `  ${paint(C.dim, '(use "git add <file>..." to include in what will be committed)')}`,
      `        ${paint(C.red, "src/components/badge.tsx")}`,
      "",
    ].join("\r\n") + "\r\n"
  );
}

const HELP = [
  `${paint(C.bold, "This shell is a fixture")} — ${paint(C.dim, "src/dev/mock-backend/fixtures/terminal.ts")}`,
  "",
  `  ${paint(C.cyan, "git status")}      a coloured working tree (matches the git panel)`,
  `  ${paint(C.cyan, "ls [-la] [dir]")}  the seeded file tree`,
  `  ${paint(C.cyan, "cat <file>")}      a seeded file's real text`,
  `  ${paint(C.cyan, "cd <dir>")}        moves the OSC-7 cwd badge`,
  `  ${paint(C.cyan, "bun run build")}   streams for ~2s, then succeeds`,
  `  ${paint(C.cyan, "bun run test")}    fails with red stderr and exit 1`,
  `  ${paint(C.cyan, "sudo <cmd>")}      asks for a password (the inline masked field)`,
  `  ${paint(C.cyan, "pwd / whoami / echo / date")}`,
  "",
  `${paint(C.dim, "Ctrl-C cancels a running command; the stop control kills it.")}`,
  "",
].join("\r\n");

const BUILD_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A long command: ~2s of output that redraws a spinner in place before it
 *  resolves, so the "running" block and the line emulator both do real work. */
async function playBuild(s: FakeSession, run: Running): Promise<void> {
  write(s, `${paint(C.dim, "$ vite build")}\r\n`);
  for (let frame = 0; frame < 18; frame++) {
    await sleep(90);
    if (s.running !== run) return;
    const glyph = BUILD_SPINNER[frame % BUILD_SPINNER.length];
    write(s, `${REDRAW}${paint(C.cyan, glyph)} bundling ${frame * 7 + 12} modules…`);
  }
  await sleep(160);
  if (s.running !== run) return;
  write(
    s,
    REDRAW +
      [
        `${paint(C.green, "✓")} 428 modules transformed.`,
        `  ${paint(C.dim, "dist/index.html")}                    0.51 kB`,
        `  ${paint(C.dim, "dist/assets/index-8f2c41a9.css")}    18.74 kB ${paint(C.grey, "│ gzip:  4.12 kB")}`,
        `  ${paint(C.dim, "dist/assets/index-b71d0e33.js")}    412.08 kB ${paint(C.grey, "│ gzip: 131.55 kB")}`,
        "",
        `${paint(C.green, "✓ built in 1.84s")}`,
        "",
      ].join("\r\n"),
  );
  finish(s, 0);
}

/** The failure state: partial success, then a red stderr trace and exit 1.
 *  One deliberately over-long line — a failing assertion is where a terminal
 *  meets text far wider than its pane. */
async function playTest(s: FakeSession, run: Running): Promise<void> {
  const rows: [number, string][] = [
    [120, `${paint(C.dim, "$ vitest run")}\r\n\r\n`],
    [220, ` ${paint(C.green, "✓")} src/lib/utils.test.ts ${paint(C.grey, "(12 tests) 41ms")}\r\n`],
    [180, ` ${paint(C.green, "✓")} src/lib/api.test.ts ${paint(C.grey, "(8 tests) 63ms")}\r\n`],
    [
      260,
      ` ${paint(C.red, "✗")} src/features/pricing/pricing-table.test.tsx ${paint(C.grey, "(1 test | 1 failed) 88ms")}\r\n`,
    ],
    [
      140,
      `   ${paint(C.red, "→ expected the empty-plan guard to return null when the project has no pricing rows at all, and instead the table threw while reading `plans` off an undefined response")}\r\n\r\n`,
    ],
  ];
  for (const [delay, text] of rows) {
    await sleep(delay);
    if (s.running !== run) return;
    write(s, text);
  }
  await sleep(200);
  if (s.running !== run) return;
  write(
    s,
    [
      paint(C.red + C.bold, "FAIL  src/features/pricing/pricing-table.test.tsx"),
      paint(C.red, "TypeError: Cannot read properties of undefined (reading 'plans')"),
      paint(C.grey, "    at PricingTable (src/features/pricing/pricing-table.tsx:42:18)"),
      paint(
        C.grey,
        "    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:15486:18)",
      ),
      "",
      ` ${paint(C.bold, "Test Files")}  ${paint(C.red, "1 failed")} | ${paint(C.green, "2 passed")} (3)`,
      `      ${paint(C.bold, "Tests")}  ${paint(C.red, "1 failed")} | ${paint(C.green, "20 passed")} (21)`,
      "",
    ].join("\r\n"),
  );
  finish(s, 1);
}

/**
 * Run one submitted line. Everything before the `133;C` marker is prompt-mode
 * noise the parser discards; the echo is written anyway because a real tty
 * echoes, and a fixture that quietly skips it teaches the wrong shape.
 */
function run(s: FakeSession, command: string): void {
  write(s, `${command}\r\n`);
  write(s, osc(`6973;C;${command}`));
  write(s, osc("133;C"));
  const running: Running = { command, awaitingPassword: false };
  s.running = running;

  const argv = command.trim().split(/\s+/);
  const [head, ...rest] = argv;

  if (head === "sudo") {
    // Leaves the block running with no trailing newline — that is exactly what
    // `looksLikePasswordPrompt` matches, and it raises the inline masked field.
    running.awaitingPassword = true;
    write(s, "[sudo] password for dev: ");
    return;
  }
  if (command.trim() === "bun run build" || command.trim() === "npm run build") {
    void playBuild(s, running);
    return;
  }
  if (command.trim() === "bun run test" || command.trim() === "npm test") {
    void playTest(s, running);
    return;
  }

  switch (head) {
    case "":
      finish(s, 0);
      return;
    case "help":
      write(s, HELP);
      finish(s, 0);
      return;
    case "pwd":
      write(s, `${s.cwd}\r\n`);
      finish(s, 0);
      return;
    case "whoami":
      write(s, "dev\r\n");
      finish(s, 0);
      return;
    case "date":
      write(s, "Fri 18 Sep 2026 11:30:00 BST\r\n");
      finish(s, 0);
      return;
    case "echo":
      write(s, `${rest.join(" ")}\r\n`);
      finish(s, 0);
      return;
    case "ls":
      write(s, lsOutput(s, rest));
      finish(s, 0);
      return;
    case "cd": {
      const target = rest[0] ? resolveAgainst(s.cwd, rest[0]) : MOCK_PROJECT.path;
      if (!absDirs().includes(target)) {
        write(s, paint(C.red, `cd: no such file or directory: ${rest[0]}`) + "\r\n");
        finish(s, 1);
        return;
      }
      setCwd(s, target);
      finish(s, 0);
      return;
    }
    case "cat": {
      const path = rest[0] ? resolvePath(s.cwd, rest[0]) : null;
      const rel = path?.startsWith(`${MOCK_PROJECT.path}/`)
        ? path.slice(MOCK_PROJECT.path.length + 1)
        : null;
      const text = rel ? fileText(rel) : "";
      if (!text) {
        write(s, paint(C.red, `cat: ${rest[0] ?? ""}: No such file or directory`) + "\r\n");
        finish(s, 1);
        return;
      }
      write(s, text.replace(/\n/g, "\r\n"));
      finish(s, 0);
      return;
    }
    case "git":
      if (rest[0] === "status") {
        write(s, gitStatusOutput());
        finish(s, 0);
        return;
      }
      write(s, paint(C.red, `git: '${rest[0] ?? ""}' is not scripted in this fixture`) + "\r\n");
      finish(s, 1);
      return;
    default:
      // The state every unscripted command lands in, rather than a silent
      // block that never finishes.
      write(s, paint(C.red, `zsh: command not found: ${head}`) + "\r\n");
      finish(s, 127);
  }
}

/** A line typed while something is running: the password answer, or stdin
 *  nobody is reading. */
function feedRunning(s: FakeSession, running: Running, line: string): void {
  if (!running.awaitingPassword) {
    write(s, `${line}\r\n`);
    return;
  }
  running.awaitingPassword = false;
  write(s, "\r\n");
  write(s, paint(C.red, "Sorry, try again.") + "\r\n");
  write(s, paint(C.dim, "sudo: 1 incorrect password attempt") + "\r\n");
  finish(s, 1);
}

/** Split typed bytes into submitted lines. Both CR and LF terminate a line:
 *  the frontend sends LF on POSIX and CR on Windows (`ENTER`). */
function feed(s: FakeSession, text: string): void {
  for (const ch of text) {
    if (ch === "\x03") {
      if (s.running) {
        write(s, paint(C.grey, "^C") + "\r\n");
        finish(s, 130);
      } else {
        prompt(s);
      }
      s.line = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      const line = s.line;
      s.line = "";
      const running = s.running;
      if (running) feedRunning(s, running, line);
      else if (line.trim() === "") prompt(s);
      else run(s, line);
      continue;
    }
    s.line += ch;
  }
}

// ── handlers ──────────────────────────────────────────────────────────────

/** A plausible `$PATH` ∪ builtins list — sorted and deduped, as Rust returns
 *  it. Short enough to read, long enough that the suggestion list scrolls. */
const COMMANDS = [
  ...new Set([
    "awk",
    "bash",
    "bun",
    "bunx",
    "cargo",
    "cat",
    "cd",
    "chmod",
    "clear",
    "cp",
    "curl",
    "date",
    "diff",
    "dirs",
    "du",
    "echo",
    "env",
    "eval",
    "exec",
    "exit",
    "export",
    "fd",
    "fg",
    "find",
    "git",
    "grep",
    "head",
    "help",
    "history",
    "jobs",
    "jq",
    "kill",
    "less",
    "let",
    "ln",
    "local",
    "ls",
    "lsof",
    "make",
    "mkdir",
    "mv",
    "node",
    "npm",
    "npx",
    "open",
    "pnpm",
    "popd",
    "ps",
    "pushd",
    "pwd",
    "read",
    "return",
    "rg",
    "rm",
    "rmdir",
    "rsync",
    "rustc",
    "rustup",
    "sed",
    "set",
    "sort",
    "source",
    "ssh",
    "stat",
    "sudo",
    "tail",
    "tar",
    "tee",
    "time",
    "touch",
    "tr",
    "trap",
    "tsc",
    "type",
    "umask",
    "unalias",
    "uniq",
    "unset",
    "vim",
    "wait",
    "wc",
    "which",
    "whoami",
    "xargs",
    "zsh",
  ]),
].sort();

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface TerminalResponses {
  terminal_create: string;
  terminal_write_text: Unread;
  terminal_write: Unread;
  terminal_resize: Unread;
  terminal_ack: Unread;
  terminal_close: Unread;
  terminal_kill_foreground: boolean;
  terminal_zsh_dir: string | null;
  terminal_list_commands: string[];
  terminal_path_complete: RawPathCompletion[];
  terminal_resolve_path: string | null;
  resolve_path: string | null;
}

export const terminalHandlers: TypedHandlers<TerminalResponses> = {
  terminal_create: ({ cols, rows, cwd, onOutput }): string => {
    const id = `pty-${++nextId}`;
    const session: FakeSession = {
      id,
      cwd: String(cwd ?? MOCK_PROJECT.path),
      cols: Number(cols ?? 80),
      rows: Number(rows ?? 24),
      channel: onOutput,
      running: null,
      line: "",
    };
    sessions.set(id, session);
    // After the invoke resolves, so the session has its pty id and drains.
    setTimeout(() => {
      // `133;A` first: it marks integration live and drops the preamble block,
      // so the banner has to arrive as a block of its own (no command → the
      // card renders headerless, which is what a shell banner should look like).
      prompt(session);
      setCwd(session, session.cwd);
      write(session, osc("133;C"));
      write(
        session,
        [
          paint(C.bold + C.magenta, "Atlas mock shell") +
            paint(C.dim, "  —  zsh 5.9 (arm64-apple-darwin24)"),
          paint(C.grey, "No PTY was harmed. Type ") +
            paint(C.cyan, "help") +
            paint(C.grey, " for what this shell knows."),
          "",
        ].join("\r\n"),
      );
      write(session, osc("133;D;0"));
      prompt(session);
    }, 30);
    return id;
  },

  terminal_write_text: ({ id, text }): null => {
    const session = sessions.get(String(id));
    if (session) feed(session, String(text ?? ""));
    return null;
  },
  terminal_write: ({ id, data }): null => {
    const session = sessions.get(String(id));
    if (!session) return null;
    const bytes: number[] = Array.isArray(data) ? data : [];
    feed(session, String.fromCharCode(...bytes));
    return null;
  },

  terminal_resize: ({ id, cols, rows }): null => {
    const session = sessions.get(String(id));
    if (session) {
      session.cols = Number(cols);
      session.rows = Number(rows);
    }
    return null;
  },
  // The credit window: real backpressure in Rust, nothing to do here.
  terminal_ack: (): null => null,
  terminal_close: ({ id }): null => {
    sessions.delete(String(id));
    return null;
  },

  /** SIGKILL to the foreground job. `false` when there is nothing to kill —
   *  which is what greys the stop control out. */
  terminal_kill_foreground: ({ id }): boolean => {
    const session = sessions.get(String(id));
    if (!session?.running) return false;
    write(session, paint(C.red, "[1]    killed     " + session.running.command) + "\r\n");
    finish(session, 137);
    return true;
  },

  // Non-null so the `sudo -s` relaunch path is exercisable rather than skipped.
  terminal_zsh_dir: (): string => "/Users/dev/.local/share/atlas/zsh-integration",

  terminal_list_commands: (): string[] => COMMANDS,

  terminal_path_complete: ({ cwd, token }): RawPathCompletion[] => {
    const raw = String(token ?? "");
    const at = raw.lastIndexOf("/");
    const dirPart = at === -1 ? "" : raw.slice(0, at + 1);
    const prefix = (at === -1 ? raw : raw.slice(at + 1)).toLowerCase();
    const dir = resolveAgainst(String(cwd ?? MOCK_PROJECT.path), dirPart || ".");
    return listDir(dir)
      .filter((entry) => {
        // Hidden entries only when the prefix asks for them, as Rust does.
        if (entry.name.startsWith(".") && !prefix.startsWith(".")) return false;
        return entry.name.toLowerCase().startsWith(prefix);
      })
      .slice(0, 50)
      .map((entry) => ({ name: entry.name, is_dir: entry.is_dir }));
  },

  // Both resolvers answer `null` for a token that is not a path — that is the
  // common case (the link regex matches plenty of prose), not an error.
  terminal_resolve_path: ({ id, raw }): string | null =>
    resolvePath(sessions.get(String(id))?.cwd ?? MOCK_PROJECT.path, String(raw ?? "")),
  resolve_path: ({ base, raw }): string | null =>
    resolvePath(String(base ?? MOCK_PROJECT.path), String(raw ?? "")),
};
