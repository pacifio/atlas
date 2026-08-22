// Memory-Chat store — local RAG chat over a project's indexed memory.
//
// Mirrors the model-chat store but: no provider/model (the model is the local
// quantized Qwen), retrieval + generation happen in Rust, and a `sources` event
// precedes the streamed answer. Messages reuse the agent chat's `ChatMessage`
// type so the existing `MessageItem` renders them.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { createStreamDeltaBuffer } from "@/lib/stream-delta-buffer";
import type { ChatMessage } from "@/types/agent";
import {
  modelchat as providerChat,
  listenModelChat,
  type ModelChatEvent,
} from "@/lib/byok/byok-chat";
import {
  memoryChat,
  listenMemoryChat,
  listenChatModelProgress,
  listenChatModelDone,
  type MemoryChatEvent,
  type ChatBackend,
  type SessionMeta,
  type SourceRef,
  type DownloadProgress,
  type MemoryChatSessionWire,
} from "../lib/memory-chat-api";
import {
  codebaseIndex,
  listenCodebaseIndexProgress,
  type CodebaseIndexStatus,
  type CodebaseIndexProgress,
  type CodebaseBuildOpts,
} from "../lib/codebase-index-api";

export type ChatMode = "local" | "provider";

export type ModelPhase =
  | "checking"
  | "not-downloaded"
  | "downloading"
  | "loading"
  | "download-failed"
  | "ready";

export interface MemoryChatSession {
  id: string;
  title: string;
  projectPath: string;
  /** "local" (on-device model) or "provider" (BYOK). */
  mode: ChatMode;
  provider: string;
  model: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  loaded: boolean;
}

interface MemoryChatState {
  modelPhase: ModelPhase;
  modelProgress: DownloadProgress | null;
  modelError: string | null;
  /** Inference backend of the loaded local model (Metal/CPU), or null if unknown. */
  backend: ChatBackend | null;
  metas: SessionMeta[];
  sessions: Record<string, MemoryChatSession>;
  activeId: string | null;
  streaming: Record<string, boolean>;
  streamToSession: Record<string, string>;
  /** assistant messageId → retrieved sources for that answer. */
  sourcesByMsg: Record<string, SourceRef[]>;
  codebaseStatus: CodebaseIndexStatus | null;
  codebaseBuilding: boolean;
  codebaseProgress: CodebaseIndexProgress | null;
  actions: {
    init: () => Promise<void>;
    checkModel: () => Promise<void>;
    downloadModel: () => Promise<void>;
    loadModel: () => Promise<void>;
    loadList: () => Promise<void>;
    newSession: (init?: { mode?: ChatMode; provider?: string; model?: string }) => string;
    selectSession: (id: string) => Promise<void>;
    deleteSession: (id: string) => Promise<void>;
    setMode: (id: string, mode: ChatMode) => void;
    setProvider: (id: string, provider: string) => void;
    setModel: (id: string, model: string) => void;
    send: (id: string, text: string, projectPath: string) => Promise<void>;
    stop: (id: string) => void;
    loadCodebaseStatus: (projectPath: string, force?: boolean) => Promise<void>;
    buildCodebaseIndex: (projectPath: string, opts: CodebaseBuildOpts) => Promise<void>;
  };
}

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: uid(),
    role,
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: now(),
    mode: role === "assistant" ? "text" : undefined,
  };
}

function toWire(s: MemoryChatSession): MemoryChatSessionWire {
  return {
    id: s.id,
    title: s.title,
    projectPath: s.projectPath,
    mode: s.mode,
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

const useMemoryChatStoreBase = create<MemoryChatState>()((set, get) => ({
  modelPhase: "checking",
  modelProgress: null,
  modelError: null,
  backend: null,
  metas: [],
  sessions: {},
  activeId: null,
  streaming: {},
  streamToSession: {},
  sourcesByMsg: {},
  codebaseStatus: null,
  codebaseBuilding: false,
  codebaseProgress: null,
  actions: {
    init: async () => {
      if (!listenerInstalled) {
        listenerInstalled = true;
        // Local-model stream events.
        await listenMemoryChat((e) => onEvent(set, get, e));
        // Provider (BYOK) stream events reuse model-chat's channel; route only
        // the stream ids this store owns, and skip usage events.
        await listenModelChat((e: ModelChatEvent) => {
          if (e.kind === "usage") return;
          if (!get().streamToSession[e.stream_id]) return;
          onEvent(set, get, e as unknown as MemoryChatEvent);
        });
      }
      await get().actions.checkModel();
      await get().actions.loadList();
    },

    checkModel: async () => {
      try {
        const status = await memoryChat.modelStatus();
        set({ modelPhase: status.downloaded ? "ready" : "not-downloaded" });
        // If a model is already cached from a prior load, reflect its backend.
        const b = await memoryChat.backend();
        if (b) set({ backend: b });
      } catch {
        set({ modelPhase: "not-downloaded" });
      }
    },

    downloadModel: async () => {
      set({ modelPhase: "downloading", modelProgress: null, modelError: null });
      const unProg = await listenChatModelProgress((p) => set({ modelProgress: p }));
      const unDone = await listenChatModelDone((d) => {
        unProg();
        unDone();
        if (d.success) {
          // Download finished → warm-load the model file ("Loading Model").
          set({ modelProgress: null });
          void get().actions.loadModel();
        } else {
          set({ modelPhase: "download-failed", modelError: d.error ?? "Download failed" });
        }
      });
      try {
        await memoryChat.modelDownload();
      } catch (e) {
        unProg();
        unDone();
        set({ modelPhase: "download-failed", modelError: String(e) });
      }
    },

    loadModel: async () => {
      set({ modelPhase: "loading", modelError: null });
      try {
        const backend = await memoryChat.modelLoad();
        set({ modelPhase: "ready", backend });
      } catch (e) {
        set({ modelPhase: "download-failed", modelError: String(e) });
      }
    },

    loadList: async () => {
      try {
        const metas = await memoryChat.sessionsList();
        set({ metas });
      } catch {
        /* none yet */
      }
    },

    newSession: (init) => {
      const id = uid();
      const session: MemoryChatSession = {
        id,
        title: "New Chat",
        projectPath: "",
        mode: init?.mode ?? "local",
        provider: init?.provider ?? "",
        model: init?.model ?? "",
        messages: [],
        createdAt: now(),
        updatedAt: now(),
        loaded: true,
      };
      set((st) => ({ sessions: { ...st.sessions, [id]: session }, activeId: id }));
      return id;
    },

    selectSession: async (id) => {
      set({ activeId: id });
      const existing = get().sessions[id];
      if (existing?.loaded) return;
      try {
        const wire = await memoryChat.sessionGet(id);
        const session: MemoryChatSession = {
          id: wire.id,
          title: wire.title,
          projectPath: wire.projectPath,
          mode: (wire.mode as ChatMode) || "local",
          provider: wire.provider ?? "",
          model: wire.model ?? "",
          createdAt: wire.createdAt,
          updatedAt: wire.updatedAt,
          loaded: true,
          messages: wire.messages.map((m) => ({
            ...makeMessage(m.role as ChatMessage["role"], m.content),
            id: m.id,
            timestamp: m.timestamp,
          })),
        };
        set((st) => ({ sessions: { ...st.sessions, [id]: session } }));
      } catch {
        /* deleted under us */
      }
    },

    deleteSession: async (id) => {
      set((st) => {
        const sessions = { ...st.sessions };
        delete sessions[id];
        return {
          sessions,
          activeId: st.activeId === id ? null : st.activeId,
          metas: st.metas.filter((m) => m.id !== id),
        };
      });
      try {
        await memoryChat.sessionDelete(id);
      } catch {
        /* ignore */
      }
    },

    setMode: (id, mode) =>
      set((st) => {
        const s = st.sessions[id];
        if (!s) return {};
        return { sessions: { ...st.sessions, [id]: { ...s, mode } } };
      }),
    setProvider: (id, provider) =>
      set((st) => {
        const s = st.sessions[id];
        if (!s) return {};
        // Reset model on provider change so the selector reloads the right list.
        return { sessions: { ...st.sessions, [id]: { ...s, provider, model: "" } } };
      }),
    setModel: (id, model) =>
      set((st) => {
        const s = st.sessions[id];
        if (!s) return {};
        return { sessions: { ...st.sessions, [id]: { ...s, model } } };
      }),

    send: async (id, text, projectPath) => {
      const session = get().sessions[id];
      const trimmed = text.trim();
      if (!session || !trimmed || get().streaming[id]) return;
      if (session.mode === "local" && get().modelPhase !== "ready") return;
      if (session.mode === "provider" && (!session.provider || !session.model)) return;

      const priorMessages = session.messages;
      const userMsg = makeMessage("user", trimmed);
      const assistantMsg = makeMessage("assistant", "");
      const title = session.title === "New Chat" ? trimmed.slice(0, 60) : session.title;
      const messages = [...priorMessages, userMsg, assistantMsg];
      const streamId = uid();

      set((st) => ({
        sessions: {
          ...st.sessions,
          [id]: { ...session, title, projectPath, messages, updatedAt: now() },
        },
        streaming: { ...st.streaming, [id]: true },
        streamToSession: { ...st.streamToSession, [streamId]: id },
      }));

      if (session.mode === "provider") {
        // Retrieve in Rust → augmented prompt; generate via the BYOK provider.
        try {
          const { prompt, sources } = await memoryChat.retrieve(projectPath, trimmed);
          set((st) => ({ sourcesByMsg: { ...st.sourcesByMsg, [assistantMsg.id]: sources } }));
          const wire = priorMessages.map((m) => ({ role: m.role, content: m.content }));
          wire.push({ role: "user", content: prompt });
          await providerChat.stream(streamId, session.provider, session.model, wire);
        } catch (e) {
          onEvent(set, get, { stream_id: streamId, kind: "error", message: String(e) });
        }
        return;
      }

      // Local mode: Rust does retrieval + on-device generation.
      const wire = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
      try {
        await memoryChat.send(streamId, projectPath, wire);
      } catch (e) {
        onEvent(set, get, { stream_id: streamId, kind: "error", message: String(e) });
      }
    },

    stop: (id) => {
      const streamId = Object.entries(get().streamToSession).find(([, sid]) => sid === id)?.[0];
      if (streamId) void memoryChat.cancel(streamId);
    },

    loadCodebaseStatus: async (projectPath, force = false) => {
      if (!force && get().codebaseStatus) return;
      try {
        const status = await codebaseIndex.status(projectPath);
        set({ codebaseStatus: status });
      } catch {
        /* none yet */
      }
    },

    buildCodebaseIndex: async (projectPath, opts) => {
      if (get().codebaseBuilding) return;
      set({ codebaseBuilding: true, codebaseProgress: null });
      const un = await listenCodebaseIndexProgress((p) => set({ codebaseProgress: p }));
      try {
        const status = await codebaseIndex.build(projectPath, opts);
        set({ codebaseStatus: status });
      } catch {
        /* keep prior status */
      } finally {
        un();
        set({ codebaseBuilding: false, codebaseProgress: null });
      }
    },
  },
}));

// Token deltas coalesce to ONE setState per animation frame (see
// stream-delta-buffer) instead of a full-Record spread + render per token.
const deltaBuffer = createStreamDeltaBuffer((chunks) => {
  useMemoryChatStoreBase.setState((st) => {
    let sessions = st.sessions;
    for (const [streamId, delta] of chunks) {
      const id = st.streamToSession[streamId];
      if (!id) continue;
      const s = sessions[id];
      if (!s) continue;
      const msgs = s.messages.slice();
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") continue;
      msgs[msgs.length - 1] = { ...last, content: last.content + delta };
      if (sessions === st.sessions) sessions = { ...sessions };
      sessions[id] = { ...s, messages: msgs };
    }
    return sessions === st.sessions ? {} : { sessions };
  });
});

function onEvent(
  set: (fn: (st: MemoryChatState) => Partial<MemoryChatState>) => void,
  get: () => MemoryChatState,
  e: MemoryChatEvent,
): void {
  if (e.kind === "backend") {
    set(() => ({ backend: e.backend }));
    return;
  }

  const id = get().streamToSession[e.stream_id];
  if (!id) return;

  if (e.kind === "text_delta") {
    deltaBuffer.push(e.stream_id, e.delta);
    return;
  }

  // Terminals persist the session from state — drain buffered text first.
  if (e.kind === "error" || e.kind === "done") {
    deltaBuffer.flush();
  }

  if (e.kind === "sources") {
    set((st) => {
      const s = st.sessions[id];
      const last = s?.messages[s.messages.length - 1];
      if (!last) return {};
      return { sourcesByMsg: { ...st.sourcesByMsg, [last.id]: e.sources } };
    });
    return;
  }

  if (e.kind === "error") {
    set((st) => {
      const s = st.sessions[id];
      if (!s) return {};
      const msgs = s.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && !last.content) {
        msgs[msgs.length - 1] = { ...last, content: `⚠️ ${e.message}` };
      }
      return { sessions: { ...st.sessions, [id]: { ...s, messages: msgs } } };
    });
    finish(set, get, id, e.stream_id);
    return;
  }

  if (e.kind === "done") {
    finish(set, get, id, e.stream_id);
  }
}

function finish(
  set: (fn: (st: MemoryChatState) => Partial<MemoryChatState>) => void,
  get: () => MemoryChatState,
  id: string,
  streamId: string,
): void {
  set((st) => {
    const streaming = { ...st.streaming };
    delete streaming[id];
    const streamToSession = { ...st.streamToSession };
    delete streamToSession[streamId];
    return { streaming, streamToSession };
  });
  const s = get().sessions[id];
  if (s) void memoryChat.sessionSave(toWire(s)).catch(() => {});
  void get().actions.loadList();
}

export const useMemoryChatStore = createSelectors(useMemoryChatStoreBase);
