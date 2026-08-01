import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SessionMeta {
  id: string;
  title: string;
  provider: string;
  model: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface ModelChatSessionWire {
  id: string;
  title: string;
  provider: string;
  model: string;
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface WireImage {
  mime: string;
  /** Base64 (no data-URL prefix). */
  data: string;
}

export interface WireMsg {
  role: string;
  content: string;
  images?: WireImage[];
}

/** Streaming events from Rust (Rig), tagged by `stream_id`. */
export type ModelChatEvent =
  | { stream_id: string; kind: "text_delta"; delta: string }
  | {
      stream_id: string;
      kind: "usage";
      input_tokens: number;
      output_tokens: number;
    }
  | { stream_id: string; kind: "done" }
  | { stream_id: string; kind: "error"; message: string };

export const modelchat = {
  models: (provider: string) =>
    invoke<{ id: string }[]>("modelchat_models", { provider }),
  stream: (
    streamId: string,
    provider: string,
    model: string,
    messages: WireMsg[],
  ) =>
    invoke<void>("modelchat_stream", { streamId, provider, model, messages }),
  cancel: (streamId: string) => invoke<void>("modelchat_cancel", { streamId }),

  sessionsList: () => invoke<SessionMeta[]>("modelchat_sessions_list"),
  sessionGet: (id: string) =>
    invoke<ModelChatSessionWire>("modelchat_session_get", { id }),
  sessionSave: (session: ModelChatSessionWire) =>
    invoke<void>("modelchat_session_save", { session }),
  sessionDelete: (id: string) =>
    invoke<void>("modelchat_session_delete", { id }),
};

export const listenModelChat = (
  handler: (e: ModelChatEvent) => void,
): Promise<UnlistenFn> =>
  listen<ModelChatEvent>("atlas:modelchat", (e) => handler(e.payload));
