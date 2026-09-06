// The Rust bridge for realtime Spaces.
//
// Only Rust holds the access JWT, so the renderer can neither dial the Space
// socket nor fetch its media. This module is the whole surface: an invoke
// facade, the control-frame types (mirroring the server contract's zod
// schemas — the contract wins over the API doc, whose examples are known to
// omit required fields), and the one listener for `atlas:spaces`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

export interface SpacePage {
  id: string;
  kind: "page" | "folder";
  name: string;
  icon: string | null;
  parent_id: string | null;
  /** Dense, zero-based among siblings, assigned by the SERVER. */
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface SpaceSummary {
  protocol: number;
  doc_version: number;
  space_id: string;
  conv_id: string;
  /** Whole tree, depth-first, parents before children. */
  pages: SpacePage[];
  active_page_id: string | null;
  archived: boolean;
}

export interface SpaceMediaUploaded {
  contentHash: string;
  mime: string;
  mediaKind: "image" | "video";
  bytes: number;
}

// ---------------------------------------------------------------------------
// Control frames (JSON strings on the socket)
// ---------------------------------------------------------------------------

export type SpaceReadOnlyReason = "archived" | "actor_ceiling";

export type SpaceServerMessage =
  | ({ t: "space.hello" } & SpaceSummary)
  | {
      t: "page.opened";
      page_id: string;
      slot: number;
      resume: boolean;
      snapshot: string | null;
      index: number;
      updates: string[];
      read_only: SpaceReadOnlyReason | null;
    }
  | { t: "page.tree"; pages: SpacePage[] }
  | { t: "page.created"; page_id: string }
  | { t: "page.closed"; page_id: string; slot: number; reason: "evicted" | "deleted" }
  | { t: "space.access"; archived: boolean }
  | { t: "error"; error: { code: string; message: string; detail?: unknown } };

export type SpaceClientMessage =
  | { t: "page.open"; page_id: string; since?: number }
  | {
      t: "page.create";
      kind?: "page" | "folder";
      name?: string;
      icon?: string | null;
      parent_id?: string | null;
    }
  | { t: "page.rename"; page_id: string; name?: string; icon?: string | null }
  | { t: "page.move"; page_id: string; parent_id: string | null; index: number }
  | { t: "page.delete"; page_id: string }
  | { t: "page.active"; page_id: string };

/** Parse an inbound control frame. Unknown `t` values (a newer server) are
 *  dropped by the caller, never thrown on. */
export function parseServerMessage(raw: string): SpaceServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== "string") return null;
  switch (t) {
    case "space.hello":
    case "page.opened":
    case "page.tree":
    case "page.created":
    case "page.closed":
    case "space.access":
    case "error":
      return parsed as SpaceServerMessage;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export type SpaceConnState = "connecting" | "open" | "backoff" | "disconnected" | "unavailable";

export type SpaceBridgeEvent =
  | { kind: "connection"; state: SpaceConnState }
  | { kind: "control"; frame: string }
  | { kind: "binary"; data: string };

export interface SpaceEnvelope {
  org: string;
  conv: string;
  ev: SpaceBridgeEvent;
}

export const spacesApi = {
  connect: (convId: string) => invoke<void>("spaces_connect", { convId }),
  disconnect: (convId: string) => invoke<void>("spaces_disconnect", { convId }),
  /** The server's `error.detail.reconnect === true` instruction. */
  cycle: (convId: string) => invoke<void>("spaces_cycle", { convId }),
  sendControl: (convId: string, message: SpaceClientMessage) =>
    invoke<void>("spaces_send_control", { convId, frame: JSON.stringify(message) }),
  /** `data` is a base64 binary frame built by `space-wire`. */
  sendBinary: (convId: string, data: string) =>
    invoke<void>("spaces_send_binary", { convId, data }),
  /** REST pre-flight; lazily creates the Space + default page server-side. */
  summary: (convId: string) => invoke<SpaceSummary>("spaces_summary", { convId }),
  /** Hash → reserve → PUT. Resolves only when the object is stored; the
   *  caller adds the node AFTER, never before. */
  mediaUpload: (convId: string, path: string) =>
    invoke<SpaceMediaUploaded>("spaces_media_upload", { convId, path }),
  /** Absolute cache path for `convertFileSrc`, keyed by immutable hash. */
  mediaFetch: (convId: string, contentHash: string, mime: string) =>
    invoke<string>("spaces_media_fetch", { convId, contentHash, mime }),
};

export function listenSpaces(handler: (envelope: SpaceEnvelope) => void): Promise<UnlistenFn> {
  return listen<SpaceEnvelope>("atlas:spaces", (e) => handler(e.payload));
}
