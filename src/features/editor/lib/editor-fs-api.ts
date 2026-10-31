// Bridge to the file commands a file tab reads and saves through
// (`src-tauri/src/commands/fs.rs`).

import { invoke } from "@tauri-apps/api/core";

/**
 * Past this, a file tab does not read the file at all: it would cross IPC
 * whole and sit in the JS heap twice (the string and the editor's document).
 * Between `LARGE_FILE_CHARS` and this, it opens read-only and unhighlighted.
 */
export const MAX_OPEN_BYTES = 64 * 1024 * 1024;

/** Must match `FILE_TOO_LARGE_PREFIX` in `commands/fs.rs`. */
const FILE_TOO_LARGE_PREFIX = "file-too-large:";

/** The file is over `MAX_OPEN_BYTES`; `bytes` is its size. */
export class FileTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`File is too large to open (${bytes} bytes)`);
    this.name = "FileTooLargeError";
  }
}

/** Read a text file for a tab, refusing one over `MAX_OPEN_BYTES` unread. */
export async function readFileForTab(path: string): Promise<string> {
  try {
    return await invoke<string>("read_file_content", { path, maxBytes: MAX_OPEN_BYTES });
  } catch (err) {
    const message = String(err);
    if (message.startsWith(FILE_TOO_LARGE_PREFIX)) {
      throw new FileTooLargeError(Number(message.slice(FILE_TOO_LARGE_PREFIX.length)) || 0);
    }
    throw err;
  }
}

/** Write `content` to `path`, replacing it. Rejects with the reason it failed. */
export function writeFileContent(path: string, content: string): Promise<void> {
  return invoke("write_file_content", { path, content });
}

/** The file's modification time in ms, or 0 when it cannot be read. */
export function fileMtimeMs(path: string): Promise<number> {
  return invoke<number>("file_mtime_ms", { path }).catch(() => 0);
}
