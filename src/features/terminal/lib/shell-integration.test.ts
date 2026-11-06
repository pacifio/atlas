import { describe, expect, it, vi } from "vitest";
import { looksLikePasswordPrompt, ShellIntegration, type TerminalEvent } from "./shell-integration";

function tracker(cwd = "/repo") {
  const events: TerminalEvent[] = [];
  const onChange = vi.fn();
  const sh = new ShellIntegration(cwd, (e) => events.push(e), onChange);
  return { sh, events, onChange };
}

/** One command, the way our zsh integration reports it. */
function run(sh: ShellIntegration, command: string) {
  sh.osc133("A");
  sh.osc6973(`C;${command}`);
  sh.osc133("C");
}

describe("ShellIntegration", () => {
  it("reports a command's start and its exit", () => {
    const { sh, events } = tracker();
    expect(sh.hasDrawnPrompt).toBe(false);
    run(sh, "bun run build");
    expect(sh.hasDrawnPrompt).toBe(true);
    expect(sh.command).toBe("bun run build");
    sh.osc133("D;2");
    expect(sh.command).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["commandStarted", "commandFinished"]);
    expect(events[1]).toMatchObject({
      command: "bun run build",
      cwd: "/repo",
      exitCode: 2,
      usedAltScreen: false,
    });
  });

  it("stays quiet for an empty line, and for a D with no command running", () => {
    const { sh, events } = tracker();
    sh.osc133("D;0");
    run(sh, "   ");
    sh.osc133("D;0");
    expect(events).toEqual([]);
  });

  it("follows OSC 7, decoded, and announces the change", () => {
    const { sh, onChange } = tracker();
    sh.osc7("file://host/Users/dev/my%20dir");
    expect(sh.cwd).toBe("/Users/dev/my dir");
    expect(onChange).toHaveBeenCalledTimes(1);
    sh.osc7("file://host/Users/dev/my%20dir");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("marks a command that took the alternate screen", () => {
    const { sh, events } = tracker();
    run(sh, "vim");
    sh.setAltScreen(true);
    sh.setAltScreen(false);
    sh.osc133("D;0");
    expect(events[1]).toMatchObject({ type: "commandFinished", usedAltScreen: true });
  });

  it("raises a bell only for a running command outside the alternate screen", () => {
    const { sh, events } = tracker();
    sh.bell();
    run(sh, "make");
    sh.setAltScreen(true);
    sh.bell();
    sh.setAltScreen(false);
    sh.bell();
    expect(events.filter((e) => e.type === "attention")).toEqual([
      expect.objectContaining({ kind: "bell", command: "make" }),
    ]);
  });

  it("raises OSC 9 and 777 notifications, skipping ConEmu progress", () => {
    const { sh, events } = tracker();
    run(sh, "deploy");
    sh.osc9("4;1;50");
    sh.osc9("done");
    sh.osc777("notify;Deploy;shipped");
    expect(events.filter((e) => e.type === "attention")).toEqual([
      expect.objectContaining({ kind: "notify", body: "done" }),
      expect.objectContaining({ kind: "notify", title: "Deploy", body: "shipped" }),
    ]);
  });

  it("asks for attention once per password prompt, re-arming after other output", () => {
    const { sh, events } = tracker();
    run(sh, "sudo ls");
    sh.checkPasswordPrompt("[sudo] password for dev: ");
    sh.checkPasswordPrompt("[sudo] password for dev: ");
    sh.checkPasswordPrompt("Sorry, try again.");
    sh.checkPasswordPrompt("[sudo] password for dev: ");
    expect(events.filter((e) => e.type === "attention")).toHaveLength(2);
  });
});

describe("looksLikePasswordPrompt", () => {
  it.each([
    ["[sudo] password for dev:", true],
    ["Password: ", true],
    ["dev@host's password:", true],
    ["Enter passphrase for key '/Users/dev/.ssh/id_ed25519':", true],
    ["password reset complete", false],
  ])("%s → %s", (line, want) => {
    expect(looksLikePasswordPrompt(line)).toBe(want);
  });
});
