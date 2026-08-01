import type { ToolCallDisplay } from "@/types/agent";

/**
 * Recognising bash/shell tool calls is subtle because the two ingest paths
 * label them differently:
 *   - Live ACP stream (`manager.rs`): `toolName` is the ACP *title*, which for
 *     Bash is the command itself (e.g. `bun install`), and `kind` is "execute".
 *   - Reloaded transcript (`transcript.rs`): `toolName` is the Claude Code tool
 *     name "Bash"; `kind` is mapped to "execute" on replay.
 * So the reliable signal is `kind === "execute"`, with a tool-name fallback for
 * any agent that doesn't set a kind.
 */
const BASH_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "execute",
  "run_command",
  "run-command",
]);

export function isBashToolCall(
  tc: Pick<ToolCallDisplay, "kind" | "toolName">,
): boolean {
  if (tc.kind === "execute") return true;
  return BASH_TOOL_NAMES.has(tc.toolName.toLowerCase());
}

/** The shell command from a bash tool call's arguments, or "" if absent. */
export function bashCommandOf(args: Record<string, unknown>): string {
  return (args.command as string) ?? (args.cmd as string) ?? "";
}
