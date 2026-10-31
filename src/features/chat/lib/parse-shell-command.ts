// What a shell command actually DID, recovered from the command string.
//
// Agents do most of their work through one tool. `cat`, `rg`, `ls` and `cargo
// test` all arrive as the same `execute` call, so classifying by tool name puts
// the same terminal glyph on every row of a turn and tells the reader nothing —
// which is exactly what the transcript looked like before this existed.
//
// This is a port of the engine's own answer to that problem,
// `vendor/atlas-engine/shell-command/src/parse_command.rs`, which is why the command
// tables below match its lists rather than anyone's intuition. Ported to TS
// rather than piped through from Rust for two reasons: the delta wire does not
// carry a parsed command today (an additive field would be the way), and the classification has
// to work for EVERY agent — an ACP agent's bash call carries a command string
// and nothing else, so a native-agent-only `parsed_cmd` field would leave the
// installed agents exactly as undifferentiated as they are now.
//
// Two deliberate narrowings against upstream:
//
//   - Upstream parses `bash -lc` scripts with a real shell grammar and returns
//     a LIST of parsed commands, because its TUI prints one line each. A marker
//     row is one line per tool call and stays that way, so this reduces to a
//     single classification and answers "run" whenever the pieces disagree.
//   - Anything with a redirect, a subshell or a backtick is "run" without
//     further thought. Upstream's grammar can see through those; a regex
//     tokenizer cannot, and a command that writes a file must never be able to
//     render as a book.
//
// The bias throughout is that `run` is the honest fallback. A wrong verb is
// worse than a generic one: "Read" over a command that deleted something is a
// lie the reader has no way to catch.

/** What a command did, in the vocabulary the marker rows render. */
export type ParsedShell =
  | { kind: "read"; path: string }
  | { kind: "list"; path: string | null }
  | { kind: "search"; query: string | null; path: string | null }
  | { kind: "run" };

const RUN: ParsedShell = { kind: "run" };

// ── Tokenizing ─────────────────────────────────────────────────────────────

/** Connectors that end one command and start the next. */
const CONNECTOR = new Set(["|", "||", "&&", ";", "\n"]);

/** Redirections to the void. They say nothing about what was read, so they are
 *  dropped rather than disqualifying the command — `rg foo 2>/dev/null` is
 *  still a search. Every OTHER redirect disqualifies it. */
const NULL_REDIRECTS = new Set(["2>/dev/null", ">/dev/null", "&>/dev/null", "2>&1"]);

/**
 * Split a command into shell words, keeping connectors as their own tokens.
 *
 * Returns null when the command contains something this cannot safely reason
 * about — an unbalanced quote, a substitution, a redirect that isn't a discard.
 * Null means "run": the caller must not fall back to a partial parse, because
 * a half-understood command is the case where a wrong icon gets minted.
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  const push = () => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];

    if (c === "\\") {
      // A trailing backslash-newline is a line continuation, not a token.
      if (command[i + 1] === "\n") {
        i++;
        continue;
      }
      if (i + 1 >= command.length) return null;
      cur += command[++i];
      started = true;
      continue;
    }

    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close === -1) return null;
      const body = command.slice(i + 1, close);
      // `"$(...)"` and `` "`...`" `` still substitute inside double quotes.
      if (c === '"' && (body.includes("$(") || body.includes("`"))) return null;
      cur += body;
      started = true;
      i = close;
      continue;
    }

    // An unquoted `#` at the start of a word opens a comment to the end of
    // the line (`# setup\ncargo test`); inside a word (`a#b`) it is text.
    if (c === "#" && !started) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }

    if (c === "$" && command[i + 1] === "(") return null;
    if (c === "`") return null;

    if (c === " " || c === "\t" || c === "\r") {
      push();
      continue;
    }

    if (c === "\n" || c === ";") {
      push();
      tokens.push("\n");
      continue;
    }

    if (c === "|" || c === "&") {
      push();
      const doubled = command[i + 1] === c;
      if (doubled) i++;
      // A lone `&` is backgrounding, which this has no story for.
      if (c === "&" && !doubled) return null;
      tokens.push(doubled ? c + c : c);
      continue;
    }

    if (c === "<") return null;
    if (c === ">") {
      // Only survives as part of a discard like `2>/dev/null`, which the
      // current token already holds the `2` of.
      const rest = command.slice(i).split(/\s/, 1)[0];
      const whole = cur + rest;
      if (!NULL_REDIRECTS.has(whole)) return null;
      i += rest.length - 1;
      cur = "";
      started = false;
      continue;
    }

    cur += c;
    started = true;
  }
  push();
  return tokens;
}

// ── Shaping ────────────────────────────────────────────────────────────────

/** Strip the wrappers that carry no meaning of their own. */
function unwrap(tokens: string[]): string[] {
  // `bash -lc '<script>'`: the script is the real command, and the quotes are
  // already gone, so it needs re-tokenizing.
  if (
    tokens.length === 3 &&
    (tokens[0] === "bash" || tokens[0] === "zsh" || tokens[0] === "sh") &&
    (tokens[1] === "-c" || tokens[1] === "-lc")
  ) {
    return tokenize(tokens[2]) ?? [];
  }
  // `yes | <cmd>` — the prefix answers prompts, it isn't the command.
  if ((tokens[0] === "yes" || tokens[0] === "y" || tokens[0] === "no") && tokens[1] === "|") {
    return tokens.slice(2);
  }
  return tokens;
}

function splitOnConnectors(tokens: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (CONNECTOR.has(t)) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const ALL_DIGITS = (s: string) => s.length > 0 && /^\d+$/.test(s);

/**
 * Pipeline plumbing that shapes output without choosing it: `| head -40`,
 * `| wc -l`, `| sort`. Dropped so the command that did the real work is what
 * gets classified — `ls src | head -40` is a listing, not a mystery.
 *
 * `head`/`tail`/`sed`/`awk` are here only in the argument shapes that CANNOT
 * name a file. Given a file operand they are reads in their own right, and the
 * classifier below treats them as such.
 */
function isFormattingHelper(tokens: string[]): boolean {
  const [head, ...rest] = tokens;
  switch (head) {
    case "wc":
    case "tr":
    case "cut":
    case "sort":
    case "uniq":
    case "tee":
    case "column":
    case "xargs":
    case "printf":
      return true;
    case "awk":
      return awkDataFile(rest) === null;
    case "sed":
      return sedReadPath(rest) === null;
    case "head":
    case "tail": {
      if (rest.length === 0) return true;
      if (rest.length === 1) return rest[0].startsWith("-");
      // `head -n 40` / `tail -n +10` — a count, no file.
      if (rest.length === 2 && (rest[0] === "-n" || rest[0] === "-c")) {
        const n = rest[1].startsWith("+") ? rest[1].slice(1) : rest[1];
        return ALL_DIGITS(n);
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Segments that are scaffolding around the real command rather than a command.
 *
 * `pwd` is deliberately NOT here even though agents prepend it for the same
 * orientation reason they prepend `cd`. It prints something the reader may
 * want, upstream keeps it, and keeping it is what makes `pwd && rg --files`
 * render as "Ran" — the fallback, and the right one, since the row would
 * otherwise claim to be only the listing.
 */
function isNoise(tokens: string[]): boolean {
  const head = tokens[0];
  return head === "cd" || head === "echo" || head === "true";
}

// ── Operand extraction ─────────────────────────────────────────────────────

/**
 * Positional arguments, with the values of `flagsWithValues` skipped.
 *
 * The `--flag=value` and `--` cases both matter in practice: `rg --glob=*.ts`
 * would otherwise donate `*.ts` as the search path, and `grep -- -pattern` is
 * the documented way to search for something starting with a dash.
 */
function operands(args: string[], flagsWithValues: string[] = []): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (afterDoubleDash) {
      out.push(a);
      continue;
    }
    if (a === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (a.startsWith("--") && a.includes("=")) continue;
    if (flagsWithValues.includes(a)) {
      if (i + 1 < args.length) skipNext = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

/** The one positional argument, or null if there are none or several. */
function soleOperand(args: string[], flagsWithValues: string[] = []): string | null {
  const ops = operands(args, flagsWithValues);
  return ops.length === 1 ? ops[0] : null;
}

/** `sed -n '120,200p' file` is a read; every other `sed` shapes or edits. */
function sedReadPath(args: string[]): string | null {
  if (!args.includes("-n")) return null;
  const isRange = (s: string | undefined) => {
    if (!s || !s.endsWith("p")) return false;
    const parts = s.slice(0, -1).split(",");
    return parts.length <= 2 && parts.every(ALL_DIGITS);
  };
  const ops = operands(args, ["-e", "-f", "--expression", "--file"]);
  const hasRange =
    ops.some(isRange) ||
    args.some((a, i) => (a === "-e" || a === "--expression") && isRange(args[i + 1]));
  if (!hasRange) return null;
  // The range itself is a positional argument; the file is whatever follows it.
  return (isRange(ops[0]) ? ops[1] : ops[0]) ?? null;
}

/** `awk '{...}' file` reads `file`; `awk '{...}'` in a pipe reads nothing. */
function awkDataFile(args: string[]): string | null {
  const ops = operands(args, ["-v", "-f", "-F"]);
  // The first operand is the program text unless `-f` supplied it.
  const usesProgramFile = args.includes("-f");
  const file = usesProgramFile ? ops[0] : ops[1];
  return file ?? null;
}

/** `head -n 40 file` / `tail -n +10 file`, but not the pipe-stage forms. */
function headTailPath(args: string[]): string | null {
  const ops = operands(args, ["-n", "-c", "--lines", "--bytes"]);
  return ops[0] ?? null;
}

const PATHISH = (s: string) =>
  s === "." || s === ".." || s.startsWith("./") || s.startsWith("../") || s.includes("/");

// ── Classification ─────────────────────────────────────────────────────────

/** grep and its lookalikes: the pattern may come from `-e`, else it's first. */
function grepLike(args: string[]): ParsedShell {
  let pattern: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-e" || a === "--regexp" || a === "-f" || a === "--file") {
      pattern ??= args[++i] ?? null;
      continue;
    }
    if (["-m", "--max-count", "-A", "-B", "-C", "--context"].includes(a)) {
      i++;
      continue;
    }
    rest.push(a);
  }
  const ops = operands(rest);
  // With an explicit `-e`, every operand is a path; without one, the first
  // operand WAS the pattern and the paths start after it.
  const query = pattern ?? ops[0] ?? null;
  const path = (pattern ? ops[0] : ops[1]) ?? null;
  return { kind: "search", query, path };
}

const LS_FLAG_VALUES = ["-I", "-w", "--block-size", "--format", "--time-style", "--color"];
const RG_FLAG_VALUES = [
  "-g",
  "--glob",
  "--iglob",
  "-t",
  "--type",
  "--type-add",
  "--type-not",
  "-m",
  "--max-count",
  "-A",
  "-B",
  "-C",
  "--context",
  "--max-depth",
];

/** One command segment → what it did. The command tables mirror upstream's. */
function classify(tokens: string[]): ParsedShell {
  const [head, ...args] = tokens;
  if (!head) return RUN;

  switch (head) {
    case "ls":
    case "eza":
    case "exa":
      return { kind: "list", path: operands(args, LS_FLAG_VALUES)[0] ?? null };
    case "tree":
      return { kind: "list", path: operands(args, ["-L", "-P", "-I", "--sort"])[0] ?? null };
    case "rg":
    case "rga": {
      const ops = operands(args, RG_FLAG_VALUES);
      // `rg --files` enumerates rather than matches — a listing, not a search.
      if (args.includes("--files")) return { kind: "list", path: ops[0] ?? null };
      return { kind: "search", query: ops[0] ?? null, path: ops[1] ?? null };
    }
    case "grep":
    case "egrep":
    case "fgrep":
      return grepLike(args);
    case "ag":
    case "ack":
    case "pt": {
      const ops = operands(args, ["-G", "-g", "--ignore-dir"]);
      return { kind: "search", query: ops[0] ?? null, path: ops[1] ?? null };
    }
    case "git": {
      if (args[0] === "grep") return grepLike(args.slice(1));
      if (args[0] === "ls-files") {
        return { kind: "list", path: operands(args.slice(1), ["--exclude"])[0] ?? null };
      }
      return RUN;
    }
    case "fd": {
      const ops = operands(args, ["-t", "--type", "-e", "--extension", "-E", "--exclude"]);
      // A single operand is the search term unless it looks like a directory.
      if (ops.length === 1) {
        return PATHISH(ops[0])
          ? { kind: "list", path: ops[0] }
          : { kind: "search", query: ops[0], path: null };
      }
      if (ops.length === 0) return { kind: "list", path: null };
      return { kind: "search", query: ops[0], path: ops[1] };
    }
    case "find": {
      const path = args.find((a) => !a.startsWith("-") && !["!", "(", ")"].includes(a)) ?? null;
      const nameAt = args.findIndex((a) => ["-name", "-iname", "-path", "-regex"].includes(a));
      const query = nameAt === -1 ? null : (args[nameAt + 1] ?? null);
      return query === null ? { kind: "list", path } : { kind: "search", query, path };
    }
    case "cat": {
      const path = soleOperand(args);
      return path ? { kind: "read", path } : RUN;
    }
    case "bat":
    case "batcat": {
      const path = soleOperand(args, ["--theme", "--language", "--style", "--line-range"]);
      return path ? { kind: "read", path } : RUN;
    }
    case "less":
    case "more": {
      const path = soleOperand(args, ["-p", "--pattern"]);
      return path ? { kind: "read", path } : RUN;
    }
    case "head":
    case "tail": {
      const path = headTailPath(args);
      return path ? { kind: "read", path } : RUN;
    }
    case "nl": {
      const path = operands(args, ["-s", "-w", "-v", "-i", "-b"])[0] ?? null;
      return path ? { kind: "read", path } : RUN;
    }
    case "sed": {
      const path = sedReadPath(args);
      return path ? { kind: "read", path } : RUN;
    }
    case "awk": {
      const path = awkDataFile(args);
      return path ? { kind: "read", path } : RUN;
    }
    default:
      return RUN;
  }
}

/**
 * Classify a whole shell command.
 *
 * Reduction rule, and the reason it is this strict: after the plumbing and the
 * scaffolding are dropped, the command must come down to exactly ONE thing it
 * did. `sed -n '1,120p' file` is a read; `pwd && rg --files -g '*.ts'` did two
 * things and gets the terminal glyph, which is what the engine's own TUI shows
 * for it. Summarising several actions as one would need a verb that promises
 * more than a single glyph can keep.
 */
export function parseShellCommand(command: string): ParsedShell {
  const tokens = tokenize(command);
  if (!tokens) return RUN;

  const segments = splitOnConnectors(unwrap(tokens))
    .filter((s) => !isFormattingHelper(s))
    .filter((s) => !isNoise(s));
  if (segments.length !== 1) return RUN;

  return classify(segments[0]);
}

/** Prefixes that run the command after them rather than being it, each with
 *  its options that take a separate value (`sudo -u root`), which have to be
 *  stepped over with that value. */
const LAUNCHERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U"])],
  ["env", new Set(["-u", "-C", "-S"])],
  ["time", new Set(["-f", "-o"])],
  ["nohup", new Set()],
  ["nice", new Set(["-n"])],
  ["command", new Set()],
  ["exec", new Set(["-a"])],
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The token a segment runs: past `FOO=bar` assignments, launchers, and the
 *  launchers' own options and their values. */
function segmentProgram(segment: string[]): string | null {
  let i = 0;
  while (i < segment.length) {
    const token = segment[i];
    if (ASSIGNMENT.test(token)) {
      i++;
      continue;
    }
    const valued = LAUNCHERS.get(token);
    if (!valued) return token;
    i++;
    while (i < segment.length && segment[i].startsWith("-")) {
      const option = segment[i++];
      if (option === "--") break;
      // `-u root` takes the next token; `-uroot` and `--user=root` do not.
      if (valued.has(option)) i++;
    }
  }
  return null;
}

/**
 * The program a command runs, for the live line ("Running sed"): the first
 * segment that is not scaffolding (`cd x &&`) or output shaping (`| head`),
 * past any `FOO=bar` assignments and launchers, as a basename. `null` when
 * the command does not tokenize.
 */
export function commandProgramName(command: string): string | null {
  const tokens = tokenize(command);
  if (!tokens) return null;
  const segments = splitOnConnectors(unwrap(tokens));
  const real = segments.filter((s) => !isNoise(s) && !isFormattingHelper(s));
  for (const segment of real.length > 0 ? real : segments) {
    const program = segmentProgram(segment);
    if (program) return program.split("/").pop() || program;
  }
  return null;
}
