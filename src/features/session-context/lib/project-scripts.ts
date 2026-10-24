// Project scripts: which one the row runs, what id a new one gets, and how
// one is run — typed into a terminal tab where the session works (the project
// root, or a pull request session's worktree).
//
// The terminal is the user's own interactive shell (`openCommandTerminal`),
// not a spawned pipe: a dev server keeps running where it can be watched and
// stopped, and a script that asks a question can be answered.
//
// A script whose command nobody here has approved — one that arrived with a
// clone or a pull request's `.atlas/config.toml` — does not run on a click:
// the overlay first shows its whole command and asks (`ProjectScriptConfirm`).
// The approval is recorded in Atlas's app data against the project, the id
// and the command, so a changed command asks again (`project_scripts.rs`).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { openCommandTerminal, shellQuote } from "@/features/terminal/lib/open-command-terminal";

import { useSessionDetailsStore } from "../stores/session-details-store";
import {
  approveProjectScript,
  listProjectScripts,
  saveProjectScripts,
  type ProjectScript,
} from "./session-context-api";

const MAX_SCRIPT_ID_LENGTH = 64;

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "script";
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

/** A fresh id for a script called `name`: its slug, numbered past any taken. */
export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    const safe =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safe)) return safe;
  }
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

/** The script the row's main button runs: the one last run, else the first. */
export function primaryProjectScript(
  scripts: readonly ProjectScript[],
  preferredId: string | null = null,
): ProjectScript | null {
  return (
    (preferredId ? scripts.find((s) => s.id === preferredId) : undefined) ?? scripts[0] ?? null
  );
}

/**
 * The line typed into the shell: change to the directory, then run. The
 * leading space keeps it out of shell history where the shell honours that
 * (bash `ignorespace`, zsh `HIST_IGNORE_SPACE`, fish).
 *
 * A script of several lines runs as one group behind the `cd`, so a failed
 * `cd` runs none of it — not just its first line, with the rest landing in
 * whatever directory the shell was in. The group closes on a line of its own,
 * so a last line ending in a comment cannot swallow it. A single line stays
 * plain, which every shell reads, fish included.
 */
export function projectScriptTerminalLine(cwd: string, command: string): string {
  const body = command.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!body.includes("\n")) return ` cd ${shellQuote(cwd)} && ${body}`;
  return ` cd ${shellQuote(cwd)} && {\n${body}\n}`;
}

/** A command's first line, for a row too narrow to show the rest. */
export function commandSummary(command: string): string {
  const lines = command.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  return lines.length > 1 ? `${lines[0]} …` : lines[0];
}

/** The script last run per project, so the row offers it next. */
const lastRun = new Map<string, string>();

export function preferredProjectScriptId(projectPath: string): string | null {
  return lastRun.get(projectPath) ?? null;
}

/** Type `script` into a new terminal tab at `cwd`, no questions asked. */
function startProjectScript(projectPath: string, script: ProjectScript, cwd: string): void {
  lastRun.set(projectPath, script.id);
  const opened = openCommandTerminal(projectScriptTerminalLine(cwd, script.command), script.name);
  if (!opened) toast.error(`Could not open a terminal for ${script.name}`);
}

/**
 * Run `script` in a new terminal tab at `cwd` (the project root unless the
 * session works elsewhere). A script whose command has not been approved asks
 * first, showing the whole command.
 */
export function runProjectScript(
  projectPath: string,
  script: ProjectScript,
  cwd: string = projectPath,
): void {
  if (!script.approved) {
    useSessionDetailsStore.getState().actions.confirmScript({ projectPath, script, cwd });
    return;
  }
  startProjectScript(projectPath, script, cwd);
}

/** The confirmation's "Run": record the approval, then run. The approval
 *  is written first, so a failure to record it runs nothing. */
export async function approveAndRunProjectScript(
  projectPath: string,
  script: ProjectScript,
  cwd: string,
): Promise<boolean> {
  try {
    await approveProjectScript(projectPath, script.id, script.command);
  } catch (e) {
    toast.error(`Could not approve ${script.name}`, { description: String(e) });
    return false;
  }
  startProjectScript(projectPath, { ...script, approved: true }, cwd);
  return true;
}

export const projectScriptsKey = (projectPath: string) =>
  ["session-context", "project-scripts", projectPath] as const;

/** The project's scripts, read from its `.atlas/config.toml`. */
export function useProjectScripts(projectPath: string | null) {
  return useQuery({
    queryKey: projectScriptsKey(projectPath ?? ""),
    queryFn: () => listProjectScripts(projectPath!),
    enabled: !!projectPath,
    staleTime: 30_000,
  });
}

/** Replace a project's scripts and refresh every reader of them. */
export function useSaveProjectScripts() {
  const client = useQueryClient();
  return async (projectPath: string, scripts: ProjectScript[]): Promise<ProjectScript[]> => {
    const saved = await saveProjectScripts(projectPath, scripts);
    client.setQueryData(projectScriptsKey(projectPath), saved);
    return saved;
  };
}
