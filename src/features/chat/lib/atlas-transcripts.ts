// Atlas's own record of a conversation.
//
// This file used to be `claude-api.ts`, and most of it read `~/.claude/projects`
// JSONL — plus Kilo's SQLite, Codex's state DB, and a live `session/list` — to
// build the session sidebar. All of that is gone (ADR-0001): the sidebar reads
// the thread-metadata store, and Atlas no longer reads another program's
// private storage for its UI.
//
// What is left is Atlas's own transcript store, under
// `<config>/agent-transcripts/`. It exists because most agents keep no
// transcript at all — opencode, cursor and every registry-installed agent are
// `TranscriptKind::None` — so before Atlas recorded them their conversations
// lived only in the renderer's memory and vanished the moment the live session
// stopped matching. Its consumer is past-session mentions (`@`), which quote
// what was actually said.

import { invoke } from "@tauri-apps/api/core";

/** One recorded session, as the mention picker lists them. */
export interface AtlasTranscriptMeta {
  id: string;
  file_path: string;
  started_at: string | null;
  last_modified: string | null;
  message_count: number;
  preview: string;
  /** Cumulative tokens processed across the session, when it was recorded. */
  total_tokens?: number;
  plugin_id: string;
}

/** Every session Atlas recorded for `cwd`, whichever agent ran it. */
export function listAtlasTranscripts(cwd: string): Promise<AtlasTranscriptMeta[]> {
  return invoke<AtlasTranscriptMeta[]>("agent_transcripts_list", { cwd });
}

/** One recorded turn. */
export interface AtlasTranscriptMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  model?: string | null;
}

/**
 * One transcript's messages, oldest first.
 *
 * Keyed by `(cwd, sessionId)` rather than a file path, because these are
 * Atlas's own files — nothing here reaches into an agent CLI's directory, and
 * there is no path for a caller to get wrong.
 */
export function readAtlasTranscript(
  cwd: string,
  sessionId: string,
): Promise<AtlasTranscriptMessage[]> {
  return invoke<AtlasTranscriptMessage[]>("agent_transcripts_read", { cwd, sessionId });
}
