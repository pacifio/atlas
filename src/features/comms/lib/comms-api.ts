// The Rust bridge for team chat.
//
// Every call to the chat host happens in Rust, because only Rust holds the
// access JWT. This module is the whole surface the renderer has: a thin invoke
// facade, and one listener for the `atlas:comms` window channel.
//
// Casing note, mirroring the Rust side: event *names* are camelCase because
// they are a discriminant; every *field* is snake_case because most of them are
// wire objects, and translating half a payload would leave two dialects of the
// same object in the store.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ChatCall,
  ChatPin,
  PromptDraft,
  ChatConversation,
  ChatReaction,
  ChatReadState,
  CommsMessage,
  RecordingTrack,
} from "../types";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "open"
  | "backoff"
  /** Stopped trying, because retrying cannot help. Needs a manual reconnect. */
  | "unavailable";

export type ConnReason = "auth" | "not_a_member" | "evicted" | "offline";

export interface ConnectionInfo {
  state: ConnectionState;
  reason: ConnReason | null;
  /** Bumped on every socket open and every cold-sync. */
  epoch: number;
  orgId: string | null;
}

export interface CommsSnapshot {
  connection: ConnectionInfo;
  me: string | null;
  conversations: ChatConversation[];
  discoverable: ChatConversation[];
  reads: ChatReadState[];
  online: string[];
  calls: ChatCall[];
}

export interface RecordingsResponse {
  state: string;
  tracks: RecordingTrack[];
}

export interface ConversationWindow {
  messages: CommsMessage[];
  reactions: ChatReaction[];
  pinned_message_ids: string[];
}

export interface MessagePage {
  messages: CommsMessage[];
  has_more: boolean;
}

export interface DmResult {
  conversation: ChatConversation;
  /** `true` = created; `false` = opened one that already existed (201 vs 200). */
  created: boolean;
}

export type CommsEvent =
  | {
      kind: "connection";
      state: ConnectionState;
      reason: ConnReason | null;
      retry_at_ms: number | null;
    }
  | { kind: "resync" }
  | { kind: "messageAppended"; conv_id: string; message: CommsMessage }
  | { kind: "messageUpdated"; conv_id: string; replaced_id: string | null; message: CommsMessage }
  | {
      kind: "conversationsChanged";
      conversations: ChatConversation[];
      discoverable: ChatConversation[];
    }
  | { kind: "readsChanged"; reads: ChatReadState[] }
  | { kind: "readChanged"; read: ChatReadState }
  | { kind: "presence"; online: string[] }
  | { kind: "typing"; conv_id: string; user_id: string; at_ms: number }
  | { kind: "reactionsChanged"; message_id: string; rows: ChatReaction[] }
  | { kind: "pinsChanged"; conv_id: string; pinned_message_ids: string[] }
  | { kind: "callChanged"; call: ChatCall }
  | {
      kind: "draftOpened";
      draft_id: string;
      draft: PromptDraft;
      snapshot: string | null;
      updates: string[];
    }
  | { kind: "draftUpdate"; draft_id: string; update: string }
  | { kind: "draftAwareness"; draft_id: string; user_id: string; state: string }
  | {
      kind: "downloadProgress";
      download_id: string;
      got_bytes: number;
      total_bytes: number;
      state: "downloading" | "complete" | "failed";
      error: string | null;
    }
  | {
      kind: "memberChanged";
      conv_id: string;
      user_id: string;
      change: "joined" | "left" | "evicted";
    }
  | {
      kind: "uploadProgress";
      upload_id: string;
      sent_bytes: number;
      total_bytes: number;
      state: "uploading" | "complete" | "failed";
      error: string | null;
    }
  | { kind: "error"; code: string; message: string; detail: unknown };

export interface CommsEnvelope {
  /** Server org id. Envelopes for a stale org are dropped mid-switch. */
  org: string;
  epoch: number;
  ev: CommsEvent;
}

/**
 * A structured refusal, when the server sent one.
 *
 * The refusals that matter carry detail the UI has to render — a frozen group
 * DM's `fork_hint`, a quota failure's `staged_bytes`. Rust passes those through
 * as a JSON string; anything else is an ordinary message.
 */
export interface CommsRefusal {
  code: string;
  message: string;
  detail?: unknown;
}

export function parseRefusal(e: unknown): CommsRefusal | null {
  if (typeof e !== "string") return null;
  try {
    const parsed = JSON.parse(e) as Partial<CommsRefusal>;
    return parsed && typeof parsed.code === "string"
      ? { code: parsed.code, message: parsed.message ?? "", detail: parsed.detail }
      : null;
  } catch {
    return null;
  }
}

export const comms = {
  status: () => invoke<ConnectionInfo>("comms_status"),
  snapshot: () => invoke<CommsSnapshot>("comms_snapshot"),

  openConversation: (convId: string) =>
    invoke<ConversationWindow>("comms_open_conversation", { convId }),
  closeConversation: (convId: string) => invoke<void>("comms_close_conversation", { convId }),
  conversationSnapshot: (convId: string) =>
    invoke<ConversationWindow>("comms_conversation_snapshot", { convId }),
  /** Pages backwards; a page is oldest-first, so append rather than reverse. */
  loadOlder: (convId: string, beforeSeq: number, limit?: number) =>
    invoke<MessagePage>("comms_load_older", { convId, beforeSeq, limit }),

  send: (convId: string, body: string, replyToId?: string | null, attachments?: string[]) =>
    invoke<{ client_msg_id: string }>("comms_send", {
      convId,
      body,
      replyToId: replyToId ?? null,
      attachments: attachments ?? [],
    }),
  /** Upload one file. `uploadId` is ours so progress events can be matched to
   *  the chip — they start arriving before this resolves. */
  uploadAttachment: (convId: string, uploadId: string, path: string) =>
    invoke<{ fileId: string }>("comms_upload_attachment", { convId, uploadId, path }),
  cancelUpload: (uploadId: string) => invoke<void>("comms_cancel_upload", { uploadId }),
  edit: (messageId: string, body: string) => invoke<void>("comms_edit", { messageId, body }),
  delete: (messageId: string) => invoke<void>("comms_delete", { messageId }),
  /** `on` is explicit state, not a toggle — pass what should be true. */
  react: (messageId: string, emoji: string, on: boolean) =>
    invoke<void>("comms_react", { messageId, emoji, on }),
  pin: (messageId: string, on: boolean) => invoke<void>("comms_pin", { messageId, on }),
  read: (convId: string, seq: number) => invoke<void>("comms_read", { convId, seq }),
  /** Throttled in Rust to one per three seconds; excess is a silent no-op. */
  typing: (convId: string) => invoke<void>("comms_typing", { convId }),

  createChannel: (name: string, visibility?: string, workspaceRefIds?: string[]) =>
    invoke<ChatConversation>("comms_create_channel", { name, visibility, workspaceRefIds }),
  createDm: (userId: string) => invoke<DmResult>("comms_create_dm", { userId }),
  createGroupDm: (memberIds: string[]) =>
    invoke<ChatConversation>("comms_create_group_dm", { memberIds }),
  join: (convId: string) => invoke<ChatConversation>("comms_join", { convId }),
  invite: (convId: string, userId: string) => invoke<void>("comms_invite", { convId, userId }),
  leave: (convId: string, userId?: string) => invoke<void>("comms_leave", { convId, userId }),
  patchConversation: (
    convId: string,
    patch: { name?: string; archived?: boolean; workspaceRefIds?: string[] },
  ) => invoke<ChatConversation>("comms_patch_conversation", { convId, ...patch }),
  /** Newest-first, unlike history paging. */
  search: (q: string, convId?: string, beforeSeq?: number) =>
    invoke<MessagePage>("comms_search", { q, convId, beforeSeq }),

  /** Announce that the event listener is attached. Call AFTER `listenComms`
   *  resolves — it is what replays state the renderer was not yet there to
   *  hear. */
  ready: () => invoke<void>("comms_ready"),
  /** Download an attachment into the local cache; resolves to an absolute
   *  path for `convertFileSrc`. Cached by file id — attachments are immutable. */
  fetchAttachment: (fileId: string, filename: string) =>
    invoke<string>("comms_fetch_attachment", { fileId, filename }),
  /** Save an attachment to a path the user picked. Shares the view cache, so a
   *  file already previewed saves without a second round trip. */
  saveAttachment: (fileId: string, filename: string, dest: string, downloadId: string) =>
    invoke<void>("comms_save_attachment", { fileId, filename, dest, downloadId }),
  /** A conversation's prompt drafts, newest-updated first. Poll-owned by the
   *  caller — no push channel exists for the list. */
  drafts: (convId: string) => invoke<PromptDraft[]>("comms_drafts", { convId }),
  createDraft: (convId: string, title: string) =>
    invoke<PromptDraft>("comms_create_draft", { convId, title }),
  /** Subscribe this socket to a draft; answered with a `draftOpened` event.
   *  Re-call on every reconnect — the subscription dies with the socket. */
  draftOpen: (draftId: string) => invoke<void>("comms_draft_open", { draftId }),
  draftUpdate: (draftId: string, update: string) =>
    invoke<void>("comms_draft_update", { draftId, update }),
  draftAwareness: (draftId: string, state: string) =>
    invoke<void>("comms_draft_awareness", { draftId, state }),
  /** Start a call. The server's join token never crosses the bridge — the
   *  browser's call tab mints its own; this answers the call row only. */
  startCall: (convId: string, mode: "audio" | "video", isPublic: boolean) =>
    invoke<ChatCall>("comms_start_call", { convId, mode, public: isPublic }),
  /** Save a call's transcript (CSV) to a user-picked path. */
  saveTranscript: (callId: string, dest: string) =>
    invoke<void>("comms_save_transcript", { callId, dest }),
  /** A call's recordings. URLs expire in ~60s, so this is asked at open time
   *  and never cached. */
  callRecordings: (callId: string) =>
    invoke<RecordingsResponse>("comms_call_recordings", { callId }),
  saveRecording: (url: string, dest: string, downloadId: string) =>
    invoke<void>("comms_save_recording", { url, dest, downloadId }),
  /** Cache a recording track locally and return its path for `convertFileSrc`.
   *  Progress is announced under the track id while it buffers. */
  fetchRecording: (url: string, trackId: string, filename: string) =>
    invoke<string>("comms_fetch_recording", { url, trackId, filename }),
  /** The full pin rail, message content riding with each pin. Fetched fresh
   *  per menu open — pins are cheap and the rail is capped at 100. */
  pins: (convId: string) => invoke<ChatPin[]>("comms_pins", { convId }),
  /** The chat service base, for building a file's canonical URL. */
  baseUrl: () => invoke<string>("comms_base_url"),
  reconnect: () => invoke<void>("comms_reconnect"),
  disconnect: () => invoke<void>("comms_disconnect"),
};

export function listenComms(handler: (envelope: CommsEnvelope) => void): Promise<UnlistenFn> {
  return listen<CommsEnvelope>("atlas:comms", (e) => handler(e.payload));
}
