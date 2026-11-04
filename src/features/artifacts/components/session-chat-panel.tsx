/**
 * Session Chat — the container for `SessionChatPanelView`.
 *
 * Everything here is assembled from parts that already exist: `ChatInput` from
 * the agent composer, `ProviderModelPills` from it too, `CheckpointScopePicker`
 * for what the next question reads. This file reads the stores and fills the
 * view's slots; the chrome is the view's.
 *
 * The only gate is an API key. Retrieval is lexical and runs in Rust, so there
 * is no model to download and no "not ready" state to sit through — either a
 * provider is configured or the panel says where to configure one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatInput, type ChatInputHandle } from "@/features/chat/components/chat-input";
import { ProviderModelPills } from "@/features/chat/components/provider-model-pills";
import { CHAT_PROVIDERS } from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { timeAgo } from "@/lib/time-ago";

import { useSessionChatStore, UNTITLED } from "../stores/session-chat-store";
import type { SessionDetail as Detail, TimelineEntry } from "../types";
import { AgentGlyph } from "./agent-glyph";
import { CheckpointScopePicker, defaultScope } from "./checkpoint-scope-picker";
import { SessionChatMessage } from "./session-chat-message";
import { SessionChatComposerView, SessionChatPanelView } from "./views/session-chat-panel-view";

export function SessionChatPanel({
  detail,
  projectPath,
  remoteProjectId,
  onClose,
}: {
  detail: Detail;
  projectPath: string;
  /** The server Project of a shared Session, so a question about a Session
   *  that is not on this machine is grounded on the server's copy. */
  remoteProjectId: string | null;
  onClose: () => void;
}) {
  const sessionId = detail.summary.id;

  const metas = useSessionChatStore.use.metasByAgent()[sessionId] ?? [];
  const activeId = useSessionChatStore.use.activeByAgent()[sessionId] ?? null;
  const threads = useSessionChatStore.use.threads();
  const streaming = useSessionChatStore.use.streaming();
  const sourcesByMsg = useSessionChatStore.use.sourcesByMsg();
  const errors = useSessionChatStore.use.errors();
  const {
    init,
    open,
    select,
    create,
    remove,
    setProvider,
    setModel,
    setCheckpointScope,
    send,
    stop,
  } = useSessionChatStore.use.actions();

  // A new thread starts scoped to the latest Checkpoint — the commit someone
  // almost always means when they open a chat about a Session they just watched
  // finish. Sessions without Checkpoints get the whole timeline.
  const newThreadScope = () => defaultScope(detail.entries);

  const byokKeys = useByokStore.use.keys();
  const byokLoaded = useByokStore.use.loaded();
  const loadByok = useByokStore.use.actions().load;

  const thread = activeId ? threads[activeId] : undefined;
  const running = activeId ? !!streaming[activeId] : false;
  const error = activeId ? errors[activeId] : null;

  useEffect(() => {
    void init();
    if (!byokLoaded) void loadByok();
  }, [init, byokLoaded, loadByok]);

  useEffect(() => {
    void open(sessionId, projectPath, defaultScope(detail.entries), remoteProjectId);
  }, [open, sessionId, projectPath, remoteProjectId]);

  /** Only used to decide whether any provider is set up at all — the picker
   *  resolves which one on its own. */
  const configured = useMemo(() => CHAT_PROVIDERS.filter((p) => !!byokKeys[p.id]), [byokKeys]);

  /**
   * Stick to the bottom while an answer streams, and stop the moment the reader
   * scrolls up.
   *
   * The naive version — scroll on message *count* — only fires twice a turn, so
   * a long answer grows off the bottom of the panel while the view sits where
   * the question was. Following the content means reacting to height, which is
   * what the `ResizeObserver` is for; the `pinned` flag is what keeps that from
   * yanking someone back down when they have deliberately scrolled away to read
   * something earlier.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A slack of a few pixels: sub-pixel layout and momentum scrolling routinely
    // leave a fraction of a pixel at the true bottom, and an exact comparison
    // would unpin on its own.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [thread?.id]);

  // A new question always returns to the bottom, whether or not the reader had
  // scrolled away — they just asked it, so it is what they want to see.
  useEffect(() => {
    pinned.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.id, thread?.messages.length]);

  // Per render, not memoised on `metas`: a label frozen when the list last
  // changed would say "2m" an hour later.
  const metaViews = metas.map((m) => ({
    id: m.id,
    title: m.title,
    updatedLabel: timeAgo(m.updatedAt),
  }));

  const state =
    configured.length === 0
      ? byokLoaded
        ? "needs-key"
        : "loading"
      : !thread || thread.messages.length === 0
        ? "starters"
        : "thread";

  return (
    <SessionChatPanelView
      title={thread?.title ?? UNTITLED}
      metas={metaViews}
      activeId={activeId}
      agentBadge={
        detail.summary.agent
          ? { agent: detail.summary.agent, glyph: <AgentGlyph agent={detail.summary.agent} mono /> }
          : null
      }
      state={state}
      startersDisabled={!thread?.provider || !thread?.model}
      messages={thread?.messages.map((message, i) => (
        <SessionChatMessage
          key={message.id}
          message={message}
          streaming={running && i === thread.messages.length - 1}
          sources={sourcesByMsg[message.id]}
        />
      ))}
      error={error ?? null}
      composer={
        configured.length > 0 && thread ? (
          <Composer
            thread={thread}
            entries={detail.entries}
            running={running}
            onSend={(text) => void send(thread.id, text)}
            onStop={() => stop(thread.id)}
            onProvider={(p) => setProvider(thread.id, p)}
            onModel={(m) => setModel(thread.id, m)}
            onScope={(scope) => setCheckpointScope(thread.id, scope)}
          />
        ) : null
      }
      scrollRef={scrollRef}
      contentRef={contentRef}
      onScroll={onScroll}
      onSelect={(id) => void select(sessionId, id)}
      onNew={() => create(sessionId, projectPath, newThreadScope())}
      onDelete={(id) => void remove(sessionId, id, newThreadScope())}
      onPickStarter={(q) => thread && void send(thread.id, q)}
      onOpenSettings={openProviderSettings}
      onClose={onClose}
    />
  );
}

/** Open Settings on Agents › Provider keys — the same deep link Memory ▸ Chat
 *  uses. Dynamically imported so the artifacts panel does not pull the settings
 *  store into its own chunk. */
function openProviderSettings(): void {
  void import("@/features/settings/lib/open-settings").then(({ openSettingsSection }) =>
    openSettingsSection("agents", "provider-keys"),
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────

function Composer({
  thread,
  entries,
  running,
  onSend,
  onStop,
  onProvider,
  onModel,
  onScope,
}: {
  thread: { provider: string; model: string; checkpointScope: string[] | null };
  entries: TimelineEntry[];
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onProvider: (id: string) => void;
  onModel: (id: string) => void;
  onScope: (scope: string[] | null) => void;
}) {
  const inputRef = useRef<ChatInputHandle>(null);
  const [hasText, setHasText] = useState(false);
  const enterToSend = useSettingsStore((s) => s.settings.enterToSend);
  const ready = !!thread.provider && !!thread.model;

  const submit = () => {
    if (running) {
      onStop();
      return;
    }
    const text = inputRef.current?.getValue()?.trim() ?? "";
    if (!text || !ready) return;
    onSend(text);
    inputRef.current?.clear();
    setHasText(false);
  };

  return (
    <SessionChatComposerView
      scopePicker={
        <CheckpointScopePicker
          entries={entries}
          scope={thread.checkpointScope}
          onChange={onScope}
        />
      }
      input={
        <ChatInput
          ref={inputRef}
          // Fixed, not conditional: `ChatInput` reads its placeholder when the
          // editor is built and never again, so a message that depended
          // on readiness froze at whatever was true on mount — "Pick a model to
          // start" stayed up long after one was picked.
          placeholder="Ask about this session…"
          onEmptyChange={(blank) => setHasText(!blank)}
          onSubmit={submit}
          enterToSend={enterToSend}
        />
      }
      modelPicker={
        // The agent composer's combo, not the Memory-Chat pair. It collapses
        // provider and model into one pill, pins the strong coding models
        // under "Recommended for coding", shows per-token pricing, and — the
        // reason it matters here — picks a sensible default model on its own.
        // The two-picker version left the composer unusable until you had
        // opened both dropdowns, and at 420px they did not fit on one row.
        <ProviderModelPills
          provider={thread.provider}
          model={thread.model}
          onProvider={onProvider}
          onModel={onModel}
        />
      }
      running={running}
      canSend={hasText && ready}
      onSubmit={submit}
    />
  );
}
