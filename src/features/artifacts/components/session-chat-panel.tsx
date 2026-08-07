/**
 * Session Chat — the right half of the split, grounded in one recorded Session.
 *
 * Everything here is assembled from parts that already exist: `ChatInput` from
 * the agent composer, `ProviderModelSelector` from Memory ▸ Chat, `MessageItem`
 * for the turns. What is new is the *framing* — a header that says which Session
 * you are asking about and which agent recorded it, and a thread picker scoped
 * to that Session.
 *
 * The only gate is an API key. Retrieval is lexical and runs in Rust, so there
 * is no model to download and no "not ready" state to sit through — either a
 * provider is configured or the panel says where to configure one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardCheck,
  GitCommitHorizontal,
  GitCompare,
  Plus,
  Search,
  Square,
  Trash2,
  Workflow,
  X,
} from "lucide-react";

import { AtlasIcon } from "@/components/atlas-icon";

import { ChatInput, type ChatInputHandle } from "@/features/chat/components/chat-input";
import { ProviderModelPills } from "@/features/chat/components/provider-model-pills";
import { CHAT_PROVIDERS } from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";

import { useSessionChatStore, UNTITLED } from "../stores/session-chat-store";
import type { SessionDetail as Detail, TimelineEntry } from "../types";
import { CheckpointScopePicker, defaultScope } from "./checkpoint-scope-picker";
import { SessionChatMessage } from "./session-chat-message";
import { AgentGlyph } from "./session-list";

/**
 * The questions worth putting in front of someone who has never used this.
 *
 * Deliberately the four the retriever is *strongest* at — each is answered
 * mostly from the always-present brief rather than from ranking, so a first
 * impression does not depend on a lucky match.
 */
const STARTERS = [
  { text: "What changed in this session?", Icon: GitCompare },
  { text: "Review this session like a PR", Icon: ClipboardCheck },
  { text: "What was each commit for?", Icon: GitCommitHorizontal },
  { text: "Diagram what this touched", Icon: Workflow },
] as const;

export function SessionChatPanel({
  detail,
  projectPath,
  onClose,
}: {
  detail: Detail;
  projectPath: string;
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
    void open(sessionId, projectPath, defaultScope(detail.entries));
  }, [open, sessionId, projectPath]);

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

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--bg-base)]">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-default)] pl-3 pr-2">
        <ThreadPicker
          title={thread?.title ?? UNTITLED}
          metas={metas}
          activeId={activeId}
          onSelect={(id) => void select(sessionId, id)}
          onNew={() => create(sessionId, projectPath, newThreadScope())}
          onDelete={(id) => void remove(sessionId, id, newThreadScope())}
        />
        <div className="flex-1" />
        {/* Which agent recorded the Session being discussed — the chat is about
         *  its work, not about the model answering. */}
        {detail.summary.agent && (
          <span
            title={`Recorded by ${detail.summary.agent}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] text-[var(--text-tertiary)]"
          >
            <AgentGlyph agent={detail.summary.agent} mono />
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="hide-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex min-h-full flex-col">
          {configured.length === 0 ? (
            <NeedsKey loaded={byokLoaded} />
          ) : !thread || thread.messages.length === 0 ? (
            <Starters
              disabled={!thread?.provider || !thread?.model}
              onPick={(q) => thread && void send(thread.id, q)}
            />
          ) : (
            <>
              {thread.messages.map((message, i) => (
                <SessionChatMessage
                  key={message.id}
                  message={message}
                  streaming={running && i === thread.messages.length - 1}
                  sources={sourcesByMsg[message.id]}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="shrink-0 border-t border-[var(--status-error)]/25 bg-[var(--status-error-muted)] px-3 py-2 text-[11.5px] leading-[1.5] text-[var(--status-error)]">
          {error}
        </p>
      )}

      {configured.length > 0 && thread && (
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
      )}
    </div>
  );
}

// ── Thread picker ────────────────────────────────────────────────────────────

/**
 * The current thread's title, opening the list of this Session's threads.
 *
 * A combo box rather than a sidebar: threads about one Session are few, and a
 * permanent list would spend a third of a 420px panel on navigation.
 */
function ThreadPicker({
  title,
  metas,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  title: string;
  metas: { id: string; title: string; updatedAt: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return metas;
    return metas.filter((m) => m.title.toLowerCase().includes(needle));
  }, [metas, query]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <span className="truncate">{title}</span>
          <ChevronDown size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-[var(--z-max)] flex max-h-[380px] w-[280px] origin-[var(--radix-popover-content-transform-origin)] flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)]/90 shadow-[var(--shadow-overlay)] backdrop-blur-2xl data-[state=closed]:animate-scale-out data-[state=open]:animate-scale-in"
        >
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2.5">
            <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a chat…"
              spellCheck={false}
              autoFocus
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11.5px] text-[var(--text-tertiary)]">
                {metas.length === 0 ? "No chats yet." : "No match."}
              </p>
            ) : (
              filtered.map((meta) => (
                <div
                  key={meta.id}
                  className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(meta.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  >
                    <Check
                      size={11}
                      className={cn(
                        "shrink-0",
                        meta.id === activeId ? "text-[var(--text-primary)]" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
                      {meta.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-ghost)]">
                      {timeAgo(meta.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete chat"
                    onClick={() => onDelete(meta.id)}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-ghost)] opacity-0 transition-all hover:text-[var(--status-error)] group-hover:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              onNew();
              setOpen(false);
            }}
            className="flex h-8 shrink-0 cursor-pointer items-center gap-2 border-t border-[var(--border-default)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Plus size={12} />
            New chat
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── Empty states ─────────────────────────────────────────────────────────────

/** Open Settings on the provider-keys section — the same deep link Memory ▸ Chat
 *  uses. Dynamically imported so the artifacts panel does not pull the layout
 *  store into its own chunk. */
function openProviderSettings(): void {
  void import("@/features/layout/stores/layout-store").then(({ useLayoutStore }) => {
    useLayoutStore.getState().actions.addTab({
      id: "settings",
      type: "settings",
      title: "Settings",
      closable: true,
      dirty: false,
      data: { section: "providers" },
    });
  });
}

function NeedsKey({ loaded }: { loaded: boolean }) {
  if (!loaded) return null;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
        Chatting with a session needs an API key.
      </p>
      <p className="text-[11.5px] leading-[1.6] text-[var(--text-tertiary)]">
        Everything else runs locally — the session is read from your own store and the question is
        answered by the provider you choose.
      </p>
      <button
        type="button"
        onClick={openProviderSettings}
        className="mt-1 flex h-7 cursor-pointer items-center rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
      >
        Add a key in Settings
      </button>
    </div>
  );
}

/**
 * The first thing you see.
 *
 * Mirrors the agent chat's welcome — mark, name, one line of purpose, then four
 * cards — because it is the same gesture in a different surface, and an empty
 * panel that looks like a different product for no reason is just friction.
 *
 * The four questions are the ones the retriever is *strongest* at: each is
 * answered mostly from the always-present session brief rather than from
 * ranking, so a first impression does not ride on a lucky match.
 */
function Starters({ disabled, onPick }: { disabled: boolean; onPick: (question: string) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="flex w-full max-w-[360px] flex-col items-center text-center">
        <div className="relative mb-4">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 size-[200px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.16]"
            style={{
              background: "radial-gradient(circle, var(--accent-primary) 0%, transparent 68%)",
            }}
          />
          <AtlasIcon
            size={48}
            className="atlas-fade-in rounded-[14px] shadow-[0_12px_50px_-12px_rgba(0,0,0,0.85)] ring-1 ring-white/10"
          />
        </div>

        <h2
          className="atlas-fade-in bg-gradient-to-b from-white to-white/55 bg-clip-text text-[18px] font-semibold tracking-tight text-transparent"
          style={{ animationDelay: "40ms" }}
        >
          Ask this session
        </h2>
        <p
          className="atlas-fade-in mt-1.5 text-[12px] leading-[1.5] text-[var(--text-tertiary)]"
          style={{ animationDelay: "80ms" }}
        >
          Grounded in what this session actually recorded.
        </p>

        <div className="mt-6 grid w-full grid-cols-2 gap-2">
          {STARTERS.map(({ text, Icon }, i) => (
            <button
              key={text}
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              style={{ animationDelay: `${120 + i * 50}ms` }}
              className={cn(
                "group atlas-fade-in flex flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2.5 text-left transition-all duration-150",
                disabled
                  ? "cursor-default opacity-50"
                  : "cursor-pointer hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)]",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="grid size-6 place-items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text-primary)]">
                  <Icon size={12} />
                </span>
                <ArrowRight
                  size={12}
                  className="-translate-x-1 text-[var(--text-ghost)] opacity-0 transition-all group-hover:translate-x-0 group-hover:text-[var(--text-secondary)] group-hover:opacity-100"
                />
              </div>
              <span className="text-[11.5px] font-medium leading-snug text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
                {text}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
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
    <div className="shrink-0 p-3">
      {/* Tucked header stating what the NEXT question will read. It sits
          BEHIND the box below (`z-0` vs `z-10`) with only its curved top
          showing — the same construction as Memory ▸ Chat's codebase strip. */}
      <CheckpointScopePicker entries={entries} scope={thread.checkpointScope} onChange={onScope} />
      {/* `relative z-10` is load-bearing: the strip above is positioned, and
          positioned elements paint over non-positioned siblings regardless of
          DOM order — without this the strip would cover the composer. */}
      <div className="relative z-10 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[0_8px_24px_rgba(0,0,0,0.35)] focus-within:border-[var(--border-focus)]">
        <ChatInput
          ref={inputRef}
          // Fixed, not conditional: `ChatInput` reads its placeholder when the
          // CodeMirror view is built and never again, so a message that depended
          // on readiness froze at whatever was true on mount — "Pick a model to
          // start" stayed up long after one was picked.
          placeholder="Ask about this session…"
          onChange={(v) => setHasText(v.trim().length > 0)}
          onSubmit={submit}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          {/* The agent composer's combo, not the Memory-Chat pair. It collapses
           *  provider and model into one pill, pins the strong coding models
           *  under "Recommended for coding", shows per-token pricing, and — the
           *  reason it matters here — picks a sensible default model on its own.
           *  The two-picker version left the composer unusable until you had
           *  opened both dropdowns, and at 420px they did not fit on one row. */}
          <ProviderModelPills
            provider={thread.provider}
            model={thread.model}
            onProvider={onProvider}
            onModel={onModel}
            showCompress={false}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!running && (!hasText || !ready)}
            aria-label={running ? "Stop" : "Send"}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
              running
                ? "cursor-pointer bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                : !hasText || !ready
                  ? "cursor-not-allowed bg-[var(--bg-elevated)] text-[var(--text-tertiary)]"
                  : "cursor-pointer bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90",
            )}
          >
            {running ? (
              <Square size={11} strokeWidth={3} fill="currentColor" />
            ) : (
              <ArrowUp size={14} strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
