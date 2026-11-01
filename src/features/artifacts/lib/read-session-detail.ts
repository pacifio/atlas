/**
 * Where an open Session's timeline is read from.
 *
 * The board row carries two addresses: `projectPath` (a checkout on this
 * machine, when there is one) and `remoteProjectId` (the server's Project).
 * The local store is the first choice because it is instant and offline — but
 * a `projectPath` is set for every Session of a Project this machine has bound,
 * **including a teammate's Sessions that only ever existed on the server**.
 * Reading those locally answers "no such Session", which the panel used to
 * render as "This session no longer exists." while the web showed it fine.
 *
 * So the rule is local first, then the server, and only then absent.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import type { OpenSession } from "../stores/artifacts-store";
import type { SessionDetail } from "../types";

/**
 * One message of a streamed remote read — mirrors `SessionStreamChunk` in
 * `commands/artifacts_cloud.rs`.
 *
 * `cached` is the copy kept on disk by an earlier read, whole as of then;
 * `unchanged` says the server agrees with it and nothing follows; each `page`
 * carries the whole-Session summary and counts with only ITS entries.
 */
export type SessionStreamChunk =
  | { kind: "cached"; detail: SessionDetail }
  | { kind: "unchanged" }
  | { kind: "page"; detail: SessionDetail; done: boolean };

export interface DetailSources {
  /** This machine's store for the Project at `projectPath`; `null` when the
   *  Session is not in it. */
  local: (projectPath: string, sessionId: string) => Promise<SessionDetail | null>;
  /** The server's copy, paged and folded into the local shape by Rust. */
  remote: (remoteProjectId: string, sessionId: string) => Promise<SessionDetail>;
  /** The same read, streamed: the disk copy first, then page by page. Absent,
   *  the whole-read `remote` is used. */
  stream?: (
    remoteProjectId: string,
    sessionId: string,
    onChunk: (chunk: SessionStreamChunk) => void,
  ) => Promise<void>;
}

const tauriSources: DetailSources = {
  local: (projectPath, sessionId) =>
    invoke<SessionDetail | null>("artifacts_session", { projectPath, sessionId }),
  remote: (projectId, sessionId) =>
    invoke<SessionDetail>("artifacts_cloud_session", { projectId, sessionId }),
  stream: (projectId, sessionId, onChunk) => {
    const onChunkChannel = new Channel<SessionStreamChunk>();
    onChunkChannel.onmessage = onChunk;
    return invoke<void>("artifacts_cloud_session_stream", {
      projectId,
      sessionId,
      onChunk: onChunkChannel,
    });
  },
};

/**
 * A view of the Session before the read has finished.
 *
 * `complete` is false while pages are still arriving — the entries are a
 * prefix. A `cached` view is complete (it is a whole earlier read) but may be
 * behind the server; the read's result replaces it if so.
 */
export type DetailProgress = (detail: SessionDetail, complete: boolean) => void;

/**
 * Read the Session `open` points at, or `null` when neither side has it.
 *
 * A remote read is attempted only when the local one came back empty and the
 * row is shared — a Session that is local-only has nowhere else to be, and
 * asking the server about it would be a 404 dressed as a delay.
 *
 * With `onProgress`, a remote read streams: what can be shown is handed over
 * as it arrives (the disk copy at once, or each page as it lands), and the
 * promise still resolves with the whole Session.
 */
export async function readSessionDetail(
  open: Pick<OpenSession, "sessionId" | "projectPath" | "remoteProjectId">,
  sources: DetailSources = tauriSources,
  onProgress?: DetailProgress,
): Promise<SessionDetail | null> {
  const remoteProjectId = open.remoteProjectId ?? null;
  if (open.projectPath) {
    const local = await sources.local(open.projectPath, open.sessionId);
    if (local) return local;
  }
  if (!remoteProjectId) return null;
  if (!onProgress || !sources.stream) return sources.remote(remoteProjectId, open.sessionId);

  let cached: SessionDetail | null = null;
  let head: SessionDetail | null = null;
  let finished = false;
  const entries: SessionDetail["entries"] = [];
  await sources.stream(remoteProjectId, open.sessionId, (chunk) => {
    if (chunk.kind === "cached") {
      cached = chunk.detail;
      onProgress(chunk.detail, true);
    } else if (chunk.kind === "unchanged") {
      finished = true;
    } else {
      finished ||= chunk.done;
      head = chunk.detail;
      entries.push(...chunk.detail.entries);
      // Behind a disk copy the pages are gathered, not shown: swapping a whole
      // (if slightly old) timeline for a growing prefix of the new one would
      // empty the reader under the person reading it.
      if (!cached) onProgress({ ...chunk.detail, entries: [...entries] }, chunk.done);
    }
  });
  // Rust stops a read that a newer one for the same Session has replaced. What
  // it gathered is a prefix, and must not be mistaken for the Session — the
  // newer read is the one whose answer counts.
  if (!finished) throw new Error("superseded by a newer read of this session");
  // Assigned inside the callback, which narrowing cannot see.
  const last = head as SessionDetail | null;
  if (last) return { ...last, entries };
  // `unchanged`: the disk copy is the Session.
  return cached;
}
