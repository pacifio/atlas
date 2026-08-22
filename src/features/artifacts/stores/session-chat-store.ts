/**
 * Session-Chat store — chat threads about one recorded Session.
 *
 * Modelled on `memory-chat-store`, with two differences that follow from the
 * feature rather than from taste:
 *
 * * **Provider-only.** There is no local-model branch, so no `mode`, no model
 *   download phase, and no gate beyond an API key.
 * * **Threads are keyed by the Session they are about.** `activeByAgent` and
 *   `metasByAgent` are per-Session maps, because opening a different Session
 *   must show a different set of threads rather than a filtered view of one
 *   global list.
 *
 * Generation is `modelchat.stream()`, the same path the BYOK chat uses. This
 * store only assembles the augmented turn and reduces the events.
 */

import { create } from "zustand";

import { createSelectors } from "@/lib/create-selectors";
import { createStreamDeltaBuffer } from "@/lib/stream-delta-buffer";
import {
  modelchat as providerChat,
  listenModelChat,
  type ModelChatEvent,
} from "@/lib/byok/byok-chat";
import type { ChatMessage } from "@/types/agent";

import {
  sessionChat,
  type SessionChatThreadWire,
  type SourceRef,
  type ThreadMeta,
} from "../lib/session-chat-api";

interface SessionChatThread {
  id: string;
  title: string;
  /** The recorded Session this thread is about. */
  agentSessionId: string;
  projectPath: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  /**
   * Commit SHAs this thread grounds on. `null` = the whole Session.
   *
   * Per THREAD rather than per panel: a thread asking about one Checkpoint
   * should still be about it when reopened tomorrow, and two threads about the
   * same Session can legitimately be scoped differently.
   */
  checkpointScope: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/** The title a thread carries until its first question names it. */
export const UNTITLED = "New chat";

interface SessionChatState {
  /** Thread metas per Session id, for the header picker. */
  metasByAgent: Record<string, ThreadMeta[]>;
  /** Which thread is open per Session id. */
  activeByAgent: Record<string, string | null>;
  threads: Record<string, SessionChatThread>;
  /** Thread id → streaming. */
  streaming: Record<string, boolean>;
  /** Stream id → thread id, so events find their thread. */
  streamToThread: Record<string, string>;
  /** Assistant message id → what its answer was grounded in. */
  sourcesByMsg: Record<string, SourceRef[]>;
  /** Thread id → the last error, cleared on the next send. */
  errors: Record<string, string | null>;

  actions: {
    /** Install the stream listener. Idempotent. */
    init: () => Promise<void>;
    /** Load this Session's thread list, opening the newest or a fresh one. */
    /** `defaultScope` seeds a thread this call has to create — see `create`. */
    open: (
      agentSessionId: string,
      projectPath: string,
      defaultScope?: string[] | null,
    ) => Promise<void>;
    select: (agentSessionId: string, threadId: string) => Promise<void>;
    /** `checkpointScope` seeds the thread's grounding — see the field's doc. */
    create: (
      agentSessionId: string,
      projectPath: string,
      checkpointScope?: string[] | null,
    ) => string;
    setCheckpointScope: (threadId: string, scope: string[] | null) => void;
    remove: (
      agentSessionId: string,
      threadId: string,
      defaultScope?: string[] | null,
    ) => Promise<void>;
    setProvider: (threadId: string, provider: string) => void;
    setModel: (threadId: string, model: string) => void;
    send: (threadId: string, text: string) => Promise<void>;
    stop: (threadId: string) => void;
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

function toWire(
  t: SessionChatThread,
  sourcesByMsg: Record<string, SourceRef[]>,
): SessionChatThreadWire {
  return {
    id: t.id,
    title: t.title,
    agentSessionId: t.agentSessionId,
    projectPath: t.projectPath,
    provider: t.provider,
    model: t.model,
    checkpointScope: t.checkpointScope,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messages: t.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      sources: sourcesByMsg[m.id],
    })),
  };
}

function fromWire(w: SessionChatThreadWire): {
  thread: SessionChatThread;
  sources: Record<string, SourceRef[]>;
} {
  const sources: Record<string, SourceRef[]> = {};
  for (const m of w.messages) {
    if (m.sources && m.sources.length > 0) sources[m.id] = m.sources;
  }
  const thread: SessionChatThread = {
    ...w,
    // Absent on threads written before scoping shipped — those grounded on the
    // whole Session, so that is what they keep doing.
    checkpointScope: w.checkpointScope ?? null,
    messages: w.messages.map((m) => ({
      id: m.id,
      role: m.role as ChatMessage["role"],
      content: m.content,
      toolCalls: [],
      fileChanges: [],
      plan: null,
      timestamp: m.timestamp,
      mode: m.role === "assistant" ? "text" : undefined,
    })),
  };
  return { thread, sources };
}

/** Persist without blocking the caller — a dropped save is a lost message, but
 *  a save that stalls the stream is a stuttering answer. */
function persist(thread: SessionChatThread, sourcesByMsg: Record<string, SourceRef[]>): void {
  void sessionChat.threadSave(toWire(thread, sourcesByMsg)).catch(() => {
    /* keep the in-memory thread; the next write retries */
  });
}

let listenerInstalled = false;

const useSessionChatStoreBase = create<SessionChatState>()((set, get) => ({
  metasByAgent: {},
  activeByAgent: {},
  threads: {},
  streaming: {},
  streamToThread: {},
  sourcesByMsg: {},
  errors: {},

  actions: {
    init: async () => {
      if (listenerInstalled) return;
      listenerInstalled = true;
      await listenModelChat((e) => onEvent(set, get, e));
    },

    open: async (agentSessionId, projectPath, defaultScope = null) => {
      let metas: ThreadMeta[] = [];
      try {
        metas = await sessionChat.threadsList(agentSessionId);
      } catch {
        /* no threads yet */
      }
      set((st) => ({ metasByAgent: { ...st.metasByAgent, [agentSessionId]: metas } }));

      // Already looking at a thread for this Session — a re-open (a tab switch,
      // a background refresh) must not throw away what is on screen.
      if (get().activeByAgent[agentSessionId]) return;

      if (metas.length === 0) {
        get().actions.create(agentSessionId, projectPath, defaultScope);
        return;
      }
      await get().actions.select(agentSessionId, metas[0].id);
    },

    select: async (agentSessionId, threadId) => {
      set((st) => ({
        activeByAgent: { ...st.activeByAgent, [agentSessionId]: threadId },
      }));
      if (get().threads[threadId]) return;
      try {
        const wire = await sessionChat.threadGet(agentSessionId, threadId);
        const { thread, sources } = fromWire(wire);
        set((st) => ({
          threads: { ...st.threads, [threadId]: thread },
          // Merge rather than replace: another thread's citations are still on
          // screen behind the picker until this one finishes loading.
          sourcesByMsg: { ...st.sourcesByMsg, ...sources },
        }));
      } catch {
        /* the file is gone; the picker will drop it on the next list */
      }
    },

    create: (agentSessionId, projectPath, checkpointScope = null) => {
      const id = uid();
      // Provider and model carry over from the thread just open: someone who
      // picked a model for this Session means it for the next question too.
      const prior = get().threads[get().activeByAgent[agentSessionId] ?? ""];
      const thread: SessionChatThread = {
        id,
        title: UNTITLED,
        agentSessionId,
        projectPath,
        provider: prior?.provider ?? "",
        model: prior?.model ?? "",
        messages: [],
        checkpointScope,
        createdAt: now(),
        updatedAt: now(),
      };
      set((st) => ({
        threads: { ...st.threads, [id]: thread },
        activeByAgent: { ...st.activeByAgent, [agentSessionId]: id },
      }));
      // Deliberately not persisted yet. An empty thread saved on creation would
      // litter the picker with "New chat" every time someone opened the panel
      // and asked nothing.
      return id;
    },

    setCheckpointScope: (threadId, scope) => {
      const thread = get().threads[threadId];
      if (!thread) return;
      const next = { ...thread, checkpointScope: scope, updatedAt: now() };
      set((st) => ({ threads: { ...st.threads, [threadId]: next } }));
      // Only persist a thread that already exists on disk — an empty one is
      // deliberately unsaved until its first question (see `create`).
      if (next.messages.length > 0) {
        void sessionChat.threadSave(toWire(next, get().sourcesByMsg)).catch(() => {});
      }
    },

    remove: async (agentSessionId, threadId, defaultScope = null) => {
      await sessionChat.threadDelete(agentSessionId, threadId).catch(() => {});
      const wasActive = get().activeByAgent[agentSessionId] === threadId;
      const projectPath = get().threads[threadId]?.projectPath ?? "";
      const metas = (get().metasByAgent[agentSessionId] ?? []).filter((m) => m.id !== threadId);
      const threads = { ...get().threads };
      delete threads[threadId];

      set((st) => ({
        threads,
        metasByAgent: { ...st.metasByAgent, [agentSessionId]: metas },
        activeByAgent: {
          ...st.activeByAgent,
          [agentSessionId]: wasActive ? null : st.activeByAgent[agentSessionId],
        },
      }));

      // Deleting what you were reading has to leave you somewhere. Without this
      // the panel renders a thread-less state with a disabled composer and no
      // way back except closing and reopening it.
      if (!wasActive) return;
      if (metas.length > 0) await get().actions.select(agentSessionId, metas[0].id);
      else get().actions.create(agentSessionId, projectPath, defaultScope);
    },

    setProvider: (threadId, provider) =>
      set((st) => {
        const t = st.threads[threadId];
        if (!t) return {};
        // The model belongs to the provider that listed it, so it cannot survive
        // the switch.
        return { threads: { ...st.threads, [threadId]: { ...t, provider, model: "" } } };
      }),

    setModel: (threadId, model) =>
      set((st) => {
        const t = st.threads[threadId];
        return t ? { threads: { ...st.threads, [threadId]: { ...t, model } } } : {};
      }),

    send: async (threadId, text) => {
      const thread = get().threads[threadId];
      const trimmed = text.trim();
      if (!thread || !trimmed || get().streaming[threadId]) return;
      if (!thread.provider || !thread.model) return;

      const priorMessages = thread.messages;
      const userMsg = makeMessage("user", trimmed);
      const assistantMsg = makeMessage("assistant", "");
      const title = thread.title === UNTITLED ? trimmed.slice(0, 60) : thread.title;
      const streamId = uid();

      const next: SessionChatThread = {
        ...thread,
        title,
        messages: [...priorMessages, userMsg, assistantMsg],
        updatedAt: now(),
      };

      set((st) => ({
        threads: { ...st.threads, [threadId]: next },
        streaming: { ...st.streaming, [threadId]: true },
        streamToThread: { ...st.streamToThread, [streamId]: threadId },
        errors: { ...st.errors, [threadId]: null },
      }));
      bumpMeta(set, next);

      try {
        // Retrieve in Rust, then stream through the shared provider path. Only
        // the newest turn is augmented: re-grounding every prior turn would
        // multiply the context by the length of the conversation, and the model
        // has already read the earlier evidence in its own history.
        const { prompt, sources } = await sessionChat.retrieve(
          thread.projectPath,
          thread.agentSessionId,
          trimmed,
          thread.checkpointScope,
        );
        set((st) => ({ sourcesByMsg: { ...st.sourcesByMsg, [assistantMsg.id]: sources } }));

        const wire = priorMessages.map((m) => ({ role: m.role, content: m.content }));
        wire.push({ role: "user", content: prompt });
        await providerChat.stream(streamId, thread.provider, thread.model, wire);
      } catch (e) {
        onEvent(set, get, { stream_id: streamId, kind: "error", message: String(e) });
      }
    },

    stop: (threadId) => {
      const streamId = Object.entries(get().streamToThread).find(([, id]) => id === threadId)?.[0];
      if (streamId) void providerChat.cancel(streamId);
    },
  },
}));

/** Keep the picker's list in step with the thread being written. */
function bumpMeta(
  set: (fn: (st: SessionChatState) => Partial<SessionChatState>) => void,
  thread: SessionChatThread,
): void {
  set((st) => {
    const list = st.metasByAgent[thread.agentSessionId] ?? [];
    const meta: ThreadMeta = {
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
    };
    const without = list.filter((m) => m.id !== thread.id);
    return {
      metasByAgent: { ...st.metasByAgent, [thread.agentSessionId]: [meta, ...without] },
    };
  });
}

// Token deltas coalesce to ONE setState per animation frame (see
// stream-delta-buffer) instead of a full-Record spread + render per token.
const deltaBuffer = createStreamDeltaBuffer((chunks) => {
  useSessionChatStoreBase.setState((st) => {
    let threads = st.threads;
    for (const [streamId, delta] of chunks) {
      const threadId = st.streamToThread[streamId];
      if (!threadId) continue;
      const t = threads[threadId];
      if (!t) continue;
      const msgs = t.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last?.role !== "assistant") continue;
      msgs[msgs.length - 1] = { ...last, content: last.content + delta };
      if (threads === st.threads) threads = { ...threads };
      threads[threadId] = { ...t, messages: msgs };
    }
    return threads === st.threads ? {} : { threads };
  });
});

function onEvent(
  set: (fn: (st: SessionChatState) => Partial<SessionChatState>) => void,
  get: () => SessionChatState,
  e: ModelChatEvent,
): void {
  // The provider stream is shared with the BYOK chat, so every event from every
  // surface arrives here. Anything this store did not start is not its business.
  const threadId = get().streamToThread[e.stream_id];
  if (!threadId) return;

  if (e.kind === "text_delta") {
    deltaBuffer.push(e.stream_id, e.delta);
    return;
  }

  if (e.kind === "done" || e.kind === "error") {
    // The terminal persists the thread from state — drain buffered text first.
    deltaBuffer.flush();
    set((st) => {
      const t = st.threads[threadId];
      const streamToThread = { ...st.streamToThread };
      delete streamToThread[e.stream_id];
      const patch: Partial<SessionChatState> = {
        streaming: { ...st.streaming, [threadId]: false },
        streamToThread,
      };
      if (e.kind === "error") patch.errors = { ...st.errors, [threadId]: e.message };
      if (t) {
        const updated = { ...t, updatedAt: now() };
        patch.threads = { ...st.threads, [threadId]: updated };
        // Persist at the end of the turn rather than per delta: one write per
        // answer instead of one per token. Sources go with it — they were set
        // before the stream opened, so they are already in `st`.
        persist(updated, st.sourcesByMsg);
      }
      return patch;
    });
  }
}

export const useSessionChatStore = createSelectors(useSessionChatStoreBase);
