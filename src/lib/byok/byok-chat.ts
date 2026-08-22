// Shared BYOK provider-chat binding.
//
// Rust owns the network/LLM work (Atlas's "Rust owns business logic" rule):
// callers send `(provider, model, messages)` and Rust streams token deltas back
// over the `atlas:modelchat` event, tagged by `streamId` so concurrent streams
// don't cross.
//
// This used to be the Model-Chat tab's private API. That tab is gone; the
// engine underneath it is not — it's the one BYOK streaming path shared by
// session chat, memory chat, the canvas AI copilot, and AI commit messages.
// It lives here rather than in a feature slice because it belongs to none of
// them.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

/** Streaming events from Rust, tagged by `stream_id`. */
export type ModelChatEvent =
  | { stream_id: string; kind: "text_delta"; delta: string }
  | { stream_id: string; kind: "usage"; input_tokens: number; output_tokens: number }
  | { stream_id: string; kind: "done" }
  | { stream_id: string; kind: "error"; message: string };

export const modelchat = {
  models: (provider: string) => invoke<{ id: string }[]>("modelchat_models", { provider }),
  stream: (streamId: string, provider: string, model: string, messages: WireMsg[]) =>
    invoke<void>("modelchat_stream", { streamId, provider, model, messages }),
  cancel: (streamId: string) => invoke<void>("modelchat_cancel", { streamId }),
};

export const listenModelChat = (handler: (e: ModelChatEvent) => void): Promise<UnlistenFn> =>
  listen<ModelChatEvent>("atlas:modelchat", (e) => handler(e.payload));
