import { describe, expect, it } from "vitest";
import { commandProgramName, parseShellCommand } from "./parse-shell-command";

/** The classification alone — the field every assertion below is really about. */
const kindOf = (cmd: string) => parseShellCommand(cmd).kind;

describe("the commands an agent actually runs", () => {
  // These are lifted verbatim from a real Atlas transcript, which is the whole
  // point: before the parser every one of them rendered as "Ran" with the same
  // terminal glyph, because they are all the same `execute` tool call.
  it("recovers the action from a real turn's worth of commands", () => {
    expect(kindOf("ls src/features/chat/components/ | head -80")).toBe("list");
    expect(kindOf('grep -rl "tool" src/features/chat/components/ | head -30')).toBe("search");
    expect(kindOf("sed -n '1,120p' src/features/chat/components/transcript-rows.tsx")).toBe("read");
    expect(kindOf("cargo test -p atlas-memory")).toBe("run");
  });

  it("names the file a read read, and the thing a search looked for", () => {
    expect(parseShellCommand("cat src/lib/utils.ts")).toEqual({
      kind: "read",
      path: "src/lib/utils.ts",
    });
    expect(parseShellCommand("rg 'TODO' src/")).toEqual({
      kind: "search",
      query: "TODO",
      path: "src/",
    });
  });
});

describe("pipelines", () => {
  it("looks past the stage that only formats the output", () => {
    // `| head -40` shapes what you see; it is not what the command did.
    expect(kindOf("rg 'foo' src | head -40")).toBe("search");
    expect(kindOf("ls -la | wc -l")).toBe("list");
    expect(kindOf("cat pkg.json | tr -d ' ' | sort")).toBe("read");
  });

  it("still treats those tools as reads when they name a file themselves", () => {
    // The same binary, two jobs: `head -n 40` is a pipe stage, `head -n 40 f`
    // is how you read the top of a file.
    expect(parseShellCommand("head -n 40 notes.md")).toEqual({ kind: "read", path: "notes.md" });
    expect(kindOf("head -n 40")).toBe("run");
  });

  it("falls back to Ran when two real commands are chained", () => {
    // Upstream's TUI shows this exact command as "Ran", and for the same
    // reason: one row cannot honestly claim both actions.
    expect(kindOf("pwd && rg --files -g '*.ts'")).toBe("run");
    expect(kindOf("git status --short; git log -1 --oneline")).toBe("run");
  });

  it("drops the scaffolding that is not a command in its own right", () => {
    expect(kindOf("cd src && cat main.ts")).toBe("read");
    expect(kindOf("echo hi && ls")).toBe("list");
  });
});

describe("commands this must refuse to classify", () => {
  // The governing rule: a wrong verb is worse than a generic one. A row that
  // says "Read" over a command that deleted something is a lie the reader has
  // no way to catch, so anything opaque to the tokenizer is "run".
  it("refuses a redirect that writes somewhere", () => {
    expect(kindOf("cat template.txt > out.txt")).toBe("run");
    expect(kindOf("ls > listing.txt")).toBe("run");
  });

  it("allows a discard, which says nothing about what was read", () => {
    expect(kindOf("rg 'foo' src 2>/dev/null")).toBe("search");
  });

  it("refuses substitutions and backticks it cannot see into", () => {
    expect(kindOf("cat $(ls | head -1)")).toBe("run");
    expect(kindOf("cat `which node`")).toBe("run");
    expect(kindOf('rg "$(cat pattern.txt)" src')).toBe("run");
  });

  it("refuses an unbalanced quote rather than guessing where it ended", () => {
    expect(kindOf("rg 'unterminated src")).toBe("run");
  });

  it("does not mistake a mutating command for a read", () => {
    expect(kindOf("sed -i 's/a/b/' file.ts")).toBe("run");
    expect(kindOf("rm -rf build")).toBe("run");
    expect(kindOf("git commit -m 'wip'")).toBe("run");
  });
});

describe("quoting and flag values", () => {
  it("keeps a quoted pattern whole, spaces and all", () => {
    expect(parseShellCommand("rg 'hello world' src")).toEqual({
      kind: "search",
      query: "hello world",
      path: "src",
    });
  });

  it("does not mistake a flag's value for a path", () => {
    // `-g '*.ts'` and `--glob=*.ts` both feed a flag; neither is where to look.
    expect(parseShellCommand("rg -g '*.ts' foo src")).toEqual({
      kind: "search",
      query: "foo",
      path: "src",
    });
    expect(parseShellCommand("rg --glob=*.ts foo")).toEqual({
      kind: "search",
      query: "foo",
      path: null,
    });
  });

  it("takes grep's pattern from -e when it is given that way", () => {
    expect(parseShellCommand("grep -rn -e 'foo|bar' src/")).toEqual({
      kind: "search",
      query: "foo|bar",
      path: "src/",
    });
  });

  it("reads through a bash -lc wrapper to the script inside", () => {
    expect(parseShellCommand("bash -lc 'cat README.md'")).toEqual({
      kind: "read",
      path: "README.md",
    });
  });
});

describe("the list and search split within one tool", () => {
  it("counts rg --files as enumerating, not matching", () => {
    // `rg --files` prints paths; it has no pattern at all.
    expect(parseShellCommand("rg --files src")).toEqual({ kind: "list", path: "src" });
  });

  it("splits find on whether it was given a name filter", () => {
    expect(parseShellCommand("find src -name '*.rs'")).toEqual({
      kind: "search",
      query: "*.rs",
      path: "src",
    });
    expect(parseShellCommand("find src -type f")).toEqual({ kind: "list", path: "src" });
  });

  it("reads a lone fd operand as a directory only when it looks like one", () => {
    expect(kindOf("fd ./src")).toBe("list");
    expect(kindOf("fd parse_command")).toBe("search");
  });
});

describe("sed, which is a read only in one exact shape", () => {
  it("accepts a line-range print with a file", () => {
    expect(parseShellCommand("sed -n '10,40p' src/a.ts")).toEqual({
      kind: "read",
      path: "src/a.ts",
    });
    expect(parseShellCommand("sed -n '40p' a.ts")).toEqual({ kind: "read", path: "a.ts" });
  });

  it("rejects every other sed", () => {
    expect(kindOf("sed -n 's/a/b/p' a.ts")).toBe("run");
    expect(kindOf("sed 's/a/b/' a.ts")).toBe("run");
  });
});

describe("the program a live line names", () => {
  it("is the command past scaffolding, assignments and launchers", () => {
    expect(commandProgramName("sed -n '1,200p' src/a.ts")).toBe("sed");
    expect(commandProgramName("cd crates/x && cargo test -p atlas")).toBe("cargo");
    expect(commandProgramName("RUST_LOG=debug sudo /usr/local/bin/node x.js")).toBe("node");
    expect(commandProgramName("bash -lc 'rg foo | head -20'")).toBe("rg");
  });

  it("steps over a launcher's options and their values", () => {
    expect(commandProgramName("sudo -u root cargo test")).toBe("cargo");
    expect(commandProgramName("sudo -E -u root cargo test")).toBe("cargo");
    expect(commandProgramName("sudo -uroot cargo test")).toBe("cargo");
    expect(commandProgramName("env -i PATH=/bin make")).toBe("make");
    expect(commandProgramName("nice -n 10 make")).toBe("make");
    expect(commandProgramName("time -v cargo build")).toBe("cargo");
    expect(commandProgramName("sudo -- rm -rf x")).toBe("rm");
  });

  it("ignores shell comments", () => {
    expect(commandProgramName("# setup\ncargo test")).toBe("cargo");
    expect(commandProgramName("cargo test # all of it")).toBe("cargo");
    expect(commandProgramName("echo a#b")).toBe("echo");
    expect(commandProgramName("rg '#include'")).toBe("rg");
  });
});
