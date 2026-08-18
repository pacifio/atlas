// Model-Chat store — ChatGPT-style BYOK sessions with persisted history.
//
// Streaming is owned by Rust (Rig): `send()` fires `modelchat_stream`, and a
// single `atlas:modelchat` listener (installed by `init()`) feeds deltas back
// through `_onEvent`. Messages reuse the agent chat's `ChatMessage` type (with
// empty tool arrays) so we can render them with the existing `MessageItem`.

import { create } from "zustand";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import { createStreamDeltaBuffer } from "@/lib/stream-delta-buffer";
import type { ChatMessage } from "@/types/agent";
import { useUsageStore } from "@/features/monitor/stores/usage-store";
import { useNotificationsStore } from "@/features/notifications/stores/notifications-store";
import { providerById } from "@/features/settings/lib/providers";
import {
  modelchat,
  listenModelChat,
  type ModelChatEvent,
  type SessionMeta,
  type ModelChatSessionWire,
} from "../lib/model-chat-api";

const notify = () => useNotificationsStore.getState().actions;

export interface ModelChatSession {
  id: string;
  title: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  /** Full messages loaded from disk (vs. a meta-only stub). */
  loaded: boolean;
}

/** An image picked in the composer, before send. */
export interface ComposerAttachment {
  mime: string;
  /** Base64 (no prefix) — sent to the model. */
  data: string;
  /** `data:` URL — for the thumbnail preview. */
  dataUrl: string;
}

interface ModelChatState {
  metas: SessionMeta[];
  sessions: Record<string, ModelChatSession>;
  activeId: string | null;
  /** sessionId → is a stream in flight. */
  streaming: Record<string, boolean>;
  /** streamId → sessionId, for routing delta events. */
  streamToSession: Record<string, string>;
  /** messageId → attachment thumbnail data-URLs (transient, NOT persisted). */
  attachmentsByMsg: Record<string, string[]>;
  actions: {
    init: () => Promise<void>;
    loadList: () => Promise<void>;
    newSession: (provider: string, model: string) => string;
    selectSession: (id: string) => Promise<void>;
    deleteSession: (id: string) => Promise<void>;
    setProvider: (id: string, provider: string) => void;
    setModel: (id: string, model: string) => void;
    send: (id: string, text: string, attachments?: ComposerAttachment[]) => Promise<void>;
    stop: (id: string) => void;
  };
}

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `mc-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: uid(),
    role,
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: role === "assistant" ? "text" : undefined,
  };
}

function toWire(s: ModelChatSession): ModelChatSessionWire {
  return {
    id: s.id,
    title: s.title,
    provider: s.provider,
    model: s.model,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: s.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
  };
}

let listenerInstalled = false;

export const useModelChatStore = createSelectors(
  create<ModelChatState>((set, get) => {
    // Token deltas coalesce here and land as ONE set() per animation frame —
    // the same batching the agent chat gets — instead of a full-Record spread
    // + panel render + virtualizer measure per token. MUST be declared before
    // the `return`: the hoisted `function onEvent` below closes over it, and a
    // `const` after the return would never initialize (TDZ throw on the first
    // streamed token — caught by oxlint's no-unreachable).
    const deltaBuffer = createStreamDeltaBuffer((chunks) => {
      set((st) => {
        let sessions = st.sessions;
        for (const [streamId, delta] of chunks) {
          const id = st.streamToSession[streamId];
          if (!id) continue; // stream ended/cancelled before the flush
          const s = sessions[id];
          if (!s) continue;
          const msgs = s.messages.slice();
          const last = msgs[msgs.length - 1];
          if (!last || last.role !== "assistant") continue;
          msgs[msgs.length - 1] = { ...last, content: last.content + delta };
          if (sessions === st.sessions) sessions = { ...sessions };
          sessions[id] = { ...s, messages: msgs };
        }
        return sessions === st.sessions ? st : { sessions };
      });
    });

    return {
      metas: [],
      sessions: {},
      activeId: null,
      streaming: {},
      streamToSession: {},
      attachmentsByMsg: {},
      actions: {
        init: async () => {
          if (!listenerInstalled) {
            listenerInstalled = true;
            await listenModelChat((e) => get().actions && onEvent(set, get, e));
          }
          await get().actions.loadList();
        },

        loadList: async () => {
          try {
            const metas = await modelchat.sessionsList();
            set({ metas });
          } catch {
            /* empty list is fine */
          }
        },

        newSession: (provider, model) => {
          const id = uid();
          const now = new Date().toISOString();
          set((st) => ({
            sessions: {
              ...st.sessions,
              [id]: {
                id,
                title: "New Chat",
                provider,
                model,
                messages: [],
                createdAt: now,
                updatedAt: now,
                loaded: true,
              },
            },
            activeId: id,
          }));
          return id;
        },

        selectSession: async (id) => {
          set({ activeId: id });
          const existing = get().sessions[id];
          if (existing?.loaded) return;
          try {
            const w = await modelchat.sessionGet(id);
            set((st) => ({
              sessions: {
                ...st.sessions,
                [id]: {
                  id: w.id,
                  title: w.title,
                  provider: w.provider,
                  model: w.model,
                  createdAt: w.createdAt,
                  updatedAt: w.updatedAt,
                  loaded: true,
                  messages: w.messages.map((m) => ({
                    ...makeMessage(m.role as ChatMessage["role"], m.content),
                    id: m.id,
                    timestamp: m.timestamp,
                  })),
                },
              },
            }));
          } catch (e) {
            toast.error(`Couldn't load chat: ${String(e)}`);
          }
        },

        deleteSession: async (id) => {
          try {
            await modelchat.sessionDelete(id);
          } catch {
            /* ignore */
          }
          set((st) => {
            const sessions = { ...st.sessions };
            delete sessions[id];
            const metas = st.metas.filter((m) => m.id !== id);
            const activeId = st.activeId === id ? (metas[0]?.id ?? null) : st.activeId;
            return { sessions, metas, activeId };
          });
        },

        setProvider: (id, provider) =>
          set((st) =>
            st.sessions[id]
              ? {
                  sessions: {
                    ...st.sessions,
                    [id]: { ...st.sessions[id], provider, model: "" },
                  },
                }
              : st,
          ),

        setModel: (id, model) =>
          set((st) =>
            st.sessions[id]
              ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id], model } } }
              : st,
          ),

        send: async (id, text, attachments) => {
          const session = get().sessions[id];
          const trimmed = text.trim();
          if (!session || !session.provider || !session.model) return;
          if (!trimmed && !attachments?.length) return;
          if (get().streaming[id]) return;

          const userMsg = makeMessage("user", trimmed);
          const assistantMsg = makeMessage("assistant", "");
          const title =
            session.title === "New Chat" ? trimmed.slice(0, 60) || "Image" : session.title;
          const messages = [...session.messages, userMsg, assistantMsg];

          const streamId = uid();
          set((st) => ({
            sessions: {
              ...st.sessions,
              [id]: {
                ...session,
                title,
                messages,
                updatedAt: new Date().toISOString(),
              },
            },
            streaming: { ...st.streaming, [id]: true },
            streamToSession: { ...st.streamToSession, [streamId]: id },
            attachmentsByMsg: attachments?.length
              ? { ...st.attachmentsByMsg, [userMsg.id]: attachments.map((a) => a.dataUrl) }
              : st.attachmentsByMsg,
          }));

          // Conversation sent to Rust = everything up to & including the new
          // user turn (exclude the empty assistant placeholder). The new user
          // turn carries any attached images.
          const wire = messages.slice(0, -1).map((m) => ({
            role: m.role,
            content: m.content,
            images:
              m.id === userMsg.id && attachments?.length
                ? attachments.map((a) => ({ mime: a.mime, data: a.data }))
                : undefined,
          }));

          try {
            await modelchat.stream(streamId, session.provider, session.model, wire);
          } catch (e) {
            // The promise resolves at stream end; a reject here is a hard
            // failure (the `error` event handles in-stream errors).
            onEvent(set, get, {
              stream_id: streamId,
              kind: "error",
              message: String(e),
            });
          }
        },

        stop: (id) => {
          const sid = Object.entries(get().streamToSession).find(([, s]) => s === id)?.[0];
          if (sid) void modelchat.cancel(sid).catch(() => {});
        },
      },
    };

    // Single delta handler shared by the listener + the send() catch.
    function onEvent(setFn: typeof set, getFn: typeof get, e: ModelChatEvent): void {
      const id = getFn().streamToSession[e.stream_id];
      if (!id) return;

      if (e.kind === "text_delta") {
        deltaBuffer.push(e.stream_id, e.delta);
        return;
      }

      // Terminals (and the done-snippet read below) must see the full text —
      // drain the buffer before the stream mapping is torn down.
      if (e.kind === "error" || e.kind === "done") {
        deltaBuffer.flush();
      }

      if (e.kind === "usage") {
        const s = getFn().sessions[id];
        if (s) {
          useUsageStore
            .getState()
            .actions.trackUsage(s.provider, s.model, e.input_tokens, e.output_tokens);
        }
        return;
      }

      if (e.kind === "error") {
        const s = getFn().sessions[id];
        const name = providerById(s?.provider ?? "")?.name ?? s?.provider ?? "Chat";
        toast.error(`${s?.provider ?? "chat"}: ${e.message}`);
        notify().add({
          kind: "chat-error",
          source: "chat",
          title: `${name} error`,
          body: e.message,
          provider: s?.provider,
          sessionId: id,
        });
        finish(setFn, getFn, id, e.stream_id);
        return;
      }

      if (e.kind === "done") {
        const s = getFn().sessions[id];
        const name = providerById(s?.provider ?? "")?.name ?? s?.provider ?? "Chat";
        const last = s?.messages[s.messages.length - 1];
        const snippet = (last?.role === "assistant" ? last.content : "").trim();
        if (snippet) {
          notify().add({
            kind: "chat-done",
            source: "chat",
            title: `${name} replied`,
            body: snippet.slice(0, 140),
            provider: s?.provider,
            sessionId: id,
          });
        }
        finish(setFn, getFn, id, e.stream_id);
      }
    }

    function finish(setFn: typeof set, getFn: typeof get, id: string, streamId: string): void {
      setFn((st) => {
        const streaming = { ...st.streaming };
        delete streaming[id];
        const streamToSession = { ...st.streamToSession };
        delete streamToSession[streamId];
        return { streaming, streamToSession };
      });
      // Persist the finished turn + refresh the sidebar ordering.
      const s = getFn().sessions[id];
      if (s) void modelchat.sessionSave(toWire(s)).catch(() => {});
      void getFn().actions.loadList();
    }
  }),
);
