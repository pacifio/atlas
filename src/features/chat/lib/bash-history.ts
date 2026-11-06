import type { ChatMessage } from "@/types/agent";
import { bashCommandOf, isBashToolCall } from "./tool-calls";

/** One shell command the agent ran, as the Bash calls panel lists it. */
export interface BashEntry {
  command: string;
  description?: string;
  /** Index of the message carrying the call, for the transcript jump. */
  messageIndex: number;
  toolCallId: string;
  timestamp: string;
}

/** The session's shell commands, newest first. Commands only, never their
 *  output: the transcript owns output. A call with no command is skipped. */
export function bashEntriesOf(messages: ChatMessage[]): BashEntry[] {
  const out: BashEntry[] = [];
  messages.forEach((m, i) => {
    for (const tc of m.toolCalls) {
      if (!isBashToolCall(tc)) continue;
      const args = tc.arguments as Record<string, unknown>;
      const cmd = bashCommandOf(args);
      const desc = (args.description as string) ?? undefined;
      if (!cmd) continue;
      out.push({
        command: cmd,
        description: desc,
        messageIndex: i,
        toolCallId: tc.id,
        timestamp: m.timestamp,
      });
    }
  });
  return out.reverse();
}
