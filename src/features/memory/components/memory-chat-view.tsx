import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Search,
  ArrowUp,
  Square,
  Download,
  Loader2,
  Sparkles,
  FileText,
  MessageSquare,
  Cpu,
  Cloud,
  KeyRound,
  Boxes,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { openFile } from "@/lib/open-file";
import { useProjectStore } from "@/features/project/stores/project-store";
import { MessageItem } from "@/features/chat/components/message-item";
import { ChatInput, type ChatInputHandle } from "@/features/chat/components/chat-input";
import { CHAT_PROVIDERS } from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { useMemoryChatStore, type ChatMode } from "../stores/memory-chat-store";
import type { SourceRef } from "../lib/memory-chat-api";
import { ProviderModelSelector } from "./provider-pickers";

type ProviderOpt = { id: string; name: string };

// Memory ▸ Chat — RAG chat over the indexed memory. Answers come from either the
// on-device model (Local) or a BYOK provider (Provider), chosen per chat.

function openProviderSettings() {
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

export function MemoryChatView() {
  const phase = useMemoryChatStore.use.modelPhase();
  const activeId = useMemoryChatStore.use.activeId();
  const { init, newSession } = useMemoryChatStore.use.actions();

  const byokKeys = useByokStore.use.keys();
  const byokLoaded = useByokStore.use.loaded();
  const { load: loadByok } = useByokStore.use.actions();

  useEffect(() => {
    void init();
    if (!byokLoaded) void loadByok();
  }, [init, byokLoaded, loadByok]);

  const configured: ProviderOpt[] = useMemo(
    () => CHAT_PROVIDERS.filter((p) => !!byokKeys[p.id]).map((p) => ({ id: p.id, name: p.name })),
    [byokKeys],
  );
  const localReady = phase === "ready";
  const providerReady = configured.length > 0;
  const showChat = localReady || providerReady;

  const makeNew = () =>
    newSession({
      mode: localReady ? "local" : "provider",
      provider: localReady ? "" : (configured[0]?.id ?? ""),
    });

  if (!showChat) {
    return <SetupGate byokLoaded={byokLoaded} />;
  }

  return (
    <div className="flex h-full bg-[var(--bg-base)]">
      <Sidebar onNew={makeNew} />
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        {activeId ? (
          <Conversation
            key={activeId}
            sessionId={activeId}
            localReady={localReady}
            providerReady={providerReady}
            configured={configured}
          />
        ) : (
          <EmptyState onNew={makeNew} />
        )}
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ onNew }: { onNew: () => void }) {
  const metas = useMemoryChatStore.use.metas();
  const activeId = useMemoryChatStore.use.activeId();
  const streaming = useMemoryChatStore.use.streaming();
  const { selectSession, deleteSession } = useMemoryChatStore.use.actions();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? metas.filter((m) => m.title.toLowerCase().includes(q)) : metas;
  }, [metas, query]);

  return (
    <div className="flex h-full w-[230px] shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-sidebar,var(--bg-secondary))]">
      <div className="flex items-center gap-1.5 h-[32px] shrink-0 border-b border-[var(--border-default)] px-3">
        <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          spellCheck={false}
          className="flex-1 bg-transparent outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] min-w-0"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-[var(--text-tertiary)]">
            {metas.length === 0 ? "No chats yet" : "No matches"}
          </div>
        ) : (
          filtered.map((m) => {
            const active = m.id === activeId;
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => void selectSession(m.id)}
                className={cn(
                  "group relative w-full text-left px-3 py-2.5 flex items-start gap-1.5 cursor-pointer select-none border-b border-[var(--border-default)]",
                  active
                    ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                )}
              >
                <span className="shrink-0 inline-flex h-[15px] items-center">
                  {streaming[m.id] ? (
                    <Loader2
                      size={10}
                      className="animate-spin text-[var(--accent-primary,#60a5fa)]"
                    />
                  ) : (
                    <MessageSquare size={11} className="text-[var(--text-tertiary)]" />
                  )}
                </span>
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-start gap-1.5">
                    <span className="text-[11px] leading-snug line-clamp-2 flex-1">{m.title}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteSession(m.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--danger,#e5484d)] transition-opacity"
                      title="Delete chat"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <span className="text-[9px] text-[var(--text-tertiary)]">
                    {timeAgo(m.updatedAt, { suffix: true })}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="flex items-center justify-end px-1.5 h-[29px] border-t border-[var(--border-default)]">
        <button
          onClick={onNew}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="New chat"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Conversation ──────────────────────────────────────────────────────────────

function Conversation({
  sessionId,
  localReady,
  providerReady,
  configured,
}: {
  sessionId: string;
  localReady: boolean;
  providerReady: boolean;
  configured: ProviderOpt[];
}) {
  const session = useMemoryChatStore((s) => s.sessions[sessionId]);
  const isStreaming = useMemoryChatStore((s) => !!s.streaming[sessionId]);
  const sourcesByMsg = useMemoryChatStore.use.sourcesByMsg();
  const { send, stop } = useMemoryChatStore.use.actions();
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = session?.messages ?? [];
  const modelLabel =
    session?.mode === "provider" ? `${session.provider} · ${session.model}` : "memory · local";

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto [overflow-anchor:none]">
        {messages.length === 0 ? (
          <div className="h-full grid place-items-center text-[12px] text-[var(--text-tertiary)]">
            Ask about this codebase’s memory…
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[760px] px-4">
            {messages.map((m, i) => (
              <div key={m.id}>
                <MessageItem
                  message={m}
                  model={m.role === "assistant" ? modelLabel : null}
                  streaming={isStreaming && i === messages.length - 1 && m.role === "assistant"}
                  isLastInGroup
                />
                {m.role === "assistant" && sourcesByMsg[m.id]?.length > 0 && (
                  <Sources sources={sourcesByMsg[m.id]} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <Composer
        sessionId={sessionId}
        running={isStreaming}
        disabled={!projectPath}
        localReady={localReady}
        providerReady={providerReady}
        configured={configured}
        onSend={(text) => void send(sessionId, text, projectPath ?? "")}
        onStop={() => stop(sessionId)}
      />
    </div>
  );
}

// ── Codebase index status / action bar ─────────────────────────────────────────

/** Codebase-index status banner — the top section *inside* the composer box
 *  (one curved border around banner + input, divided by a line). */
function CodebaseIndexBanner({
  mode,
  provider,
  model,
  localReady,
}: {
  mode: ChatMode;
  provider: string;
  model: string;
  localReady: boolean;
}) {
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const status = useMemoryChatStore.use.codebaseStatus();
  const building = useMemoryChatStore.use.codebaseBuilding();
  const progress = useMemoryChatStore.use.codebaseProgress();
  const { loadCodebaseStatus, buildCodebaseIndex } = useMemoryChatStore.use.actions();

  useEffect(() => {
    if (projectPath) void loadCodebaseStatus(projectPath);
  }, [projectPath, loadCodebaseStatus]);

  if (!projectPath) return null;

  const onIndex = () => {
    // Reuse the chat's backend: provider summaries when a provider chat is set up,
    // local summaries when the local model is ready, else structural-only.
    const opts =
      mode === "provider" && provider && model
        ? ({ mode: "incremental", backend: "provider", provider, model } as const)
        : localReady
          ? ({ mode: "incremental", backend: "local" } as const)
          : ({ mode: "incremental", backend: "structural" } as const);
    void buildCodebaseIndex(projectPath, opts);
  };

  const lead = status?.indexed ? `Codebase: ${status.fileCount} files` : "Codebase not indexed";
  const rest = status?.indexed
    ? (status.summaryCount ? ` · ${status.summaryCount} summarized` : "") +
      (status.builtAtMs
        ? ` · updated ${timeAgo(new Date(status.builtAtMs).toISOString(), { suffix: true })}`
        : "")
    : " — answers may be outdated";

  return (
    <div className="relative z-0 mx-2 -mb-3.5 flex items-center justify-between gap-3 rounded-t-xl bg-[var(--bg-tertiary)] px-3.5 pt-1.5 pb-5 text-[11px]">
      <span className="flex min-w-0 items-center gap-2 truncate">
        <Boxes size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="truncate">
          <span className="font-semibold text-[var(--text-primary)]">{lead}</span>
          {rest && <span className="text-[var(--text-tertiary)]">{rest}</span>}
        </span>
      </span>
      {building ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[var(--text-tertiary)]">
          <Loader2 size={11} className="animate-spin" />
          {progress ? phaseLabel(progress) : "Indexing…"}
        </span>
      ) : (
        <button
          onClick={onIndex}
          title="Scan the current codebase so the chat is grounded in up-to-date source"
          className="shrink-0 font-medium text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)] cursor-pointer"
        >
          {status?.indexed ? "Re-index" : "Index now"}
        </button>
      )}
    </div>
  );
}

function phaseLabel(p: { phase: string; current: number; total: number }): string {
  if (p.phase === "scanning") return "Scanning…";
  if (p.phase === "summarizing") return `Summarizing ${p.current}/${p.total}`;
  if (p.phase === "embedding") return "Embedding…";
  return "Indexing…";
}

function Sources({ sources }: { sources: SourceRef[] }) {
  return (
    <div className="mx-auto max-w-[760px] -mt-2 mb-4 flex flex-wrap gap-1.5 pl-11">
      {sources.map((s) => {
        const openable = !!s.filePath;
        const base =
          "inline-flex items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]";
        const tip = `${s.source} · ${(s.score * 100).toFixed(0)}% match${openable ? " · click to open" : ""}`;
        if (!openable) {
          return (
            <span key={s.id} title={tip} className={base}>
              <FileText size={9} />
              <span className="max-w-[160px] truncate">{s.title}</span>
            </span>
          );
        }
        return (
          <button
            key={s.id}
            type="button"
            title={tip}
            onClick={() => openFile(s.filePath as string)}
            className={cn(
              base,
              "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer",
            )}
          >
            <FileText size={9} />
            <span className="max-w-[160px] truncate">{s.title}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Composer ──────────────────────────────────────────────────────────────────

function ModeToggle({
  mode,
  localReady,
  providerReady,
  onMode,
}: {
  mode: ChatMode;
  localReady: boolean;
  providerReady: boolean;
  onMode: (m: ChatMode) => void;
}) {
  const seg = (m: ChatMode, label: string, Icon: typeof Cpu, enabled: boolean) => (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => enabled && onMode(m)}
      title={enabled ? `Use ${label.toLowerCase()}` : `${label} unavailable`}
      className={cn(
        "flex items-center gap-1 h-[22px] px-2 rounded-full text-[10px] font-medium transition-colors",
        mode === m
          ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
        !enabled && "opacity-40 cursor-not-allowed",
      )}
    >
      <Icon size={11} />
      {label}
    </button>
  );
  // Local is always switchable — if the model isn't installed, the composer
  // shows an "Install model" button in place of Send. `localReady` only affects
  // whether sending is enabled, handled by the composer.
  void localReady;
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-border-default bg-bg-elevated p-0.5 h-[26px] shrink-0">
      {seg("local", "Local", Cpu, true)}
      {seg("provider", "Provider", Cloud, providerReady)}
    </div>
  );
}

/** Determinate ring whose arc fills with `pct`. */
function ArcProgress({ pct, size = 13 }: { pct: number; size?: number }) {
  const r = (size - 2) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const off = c * (1 - clamped / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth="2"
        stroke="var(--border-default)"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="var(--accent-primary,#60a5fa)"
        strokeDasharray={c}
        strokeDashoffset={off}
        className="transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  );
}

/** Replaces the send button when Local is selected but the model isn't ready.
 *  Idle → "Install model"; downloading → arc % + "Downloading Model.. N%";
 *  warming → "Loading Model". */
function InstallButton() {
  const phase = useMemoryChatStore.use.modelPhase();
  const progress = useMemoryChatStore.use.modelProgress();
  const error = useMemoryChatStore.use.modelError();
  const { downloadModel } = useMemoryChatStore.use.actions();
  const pct =
    progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0;

  const pill =
    "inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full border border-border-default bg-bg-elevated text-[10px] font-medium text-text-secondary";

  if (phase === "downloading") {
    return (
      <span className={pill}>
        <ArcProgress pct={pct} /> Downloading Model.. {pct}%
      </span>
    );
  }
  if (phase === "loading") {
    return (
      <span className={pill}>
        <Loader2 size={12} className="animate-spin" /> Loading Model
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void downloadModel()}
      title={
        phase === "download-failed"
          ? (error ?? "Download failed — retry")
          : "Download the local model"
      }
      className={cn(
        pill,
        "shadow-[0_2px_8px_rgba(0,0,0,0.35)] hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer",
      )}
    >
      <Download size={12} /> Install model
    </button>
  );
}

/** Tiny indicator of the local model's inference backend (Metal GPU vs CPU). CPU
 *  means candle's Metal kernels couldn't compile on this OS and we fell back —
 *  the chat still works, just slower. */
function BackendPill() {
  const backend = useMemoryChatStore.use.backend();
  if (!backend) return null;
  const metal = backend === "metal";
  return (
    <span
      title={
        metal
          ? "Running on the Apple-Silicon GPU (Metal)"
          : "Running on CPU — the GPU (Metal) kernels aren’t available on this machine, so generation is slower"
      }
      className="inline-flex items-center gap-1 h-[26px] px-2 rounded-full border border-border-default bg-bg-elevated text-[10px] font-medium text-text-tertiary"
    >
      {metal ? <Zap size={11} className="text-text-secondary" /> : <Cpu size={11} />}
      {metal ? "Metal" : "CPU"}
    </span>
  );
}

function Composer({
  sessionId,
  running,
  disabled,
  localReady,
  providerReady,
  configured,
  onSend,
  onStop,
}: {
  sessionId: string;
  running: boolean;
  disabled: boolean;
  localReady: boolean;
  providerReady: boolean;
  configured: ProviderOpt[];
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const session = useMemoryChatStore((s) => s.sessions[sessionId]);
  const phase = useMemoryChatStore.use.modelPhase();
  const { setMode, setProvider, setModel } = useMemoryChatStore.use.actions();
  const mode: ChatMode = session?.mode ?? "local";
  const provider = session?.provider ?? "";
  const model = session?.model ?? "";

  const inputRef = useRef<ChatInputHandle>(null);
  const [hasText, setHasText] = useState(false);
  const enterToSend = useProjectStore((s) => s.settings.enterToSend);

  // Local selected but model not ready → offer install instead of send.
  const needsInstall = mode === "local" && phase !== "ready";

  // When switching to provider mode with nothing chosen, pick the first provider.
  useEffect(() => {
    if (mode === "provider" && !provider && configured[0]) {
      setProvider(sessionId, configured[0].id);
    }
  }, [mode, provider, configured, sessionId, setProvider]);

  const canSend = mode === "local" ? localReady : !!provider && !!model;

  const submit = () => {
    if (running) {
      onStop();
      return;
    }
    const text = inputRef.current?.getValue()?.trim() ?? "";
    if (!text || disabled || !canSend) return;
    onSend(text);
    inputRef.current?.clear();
    setHasText(false);
  };

  return (
    <div className="shrink-0 p-3">
      <div className="mx-auto w-full max-w-[760px]">
        {/* Tip peeks above the rounded input and tucks behind it (separate
            rounded-top surface, contrasting shade, no border). */}
        <CodebaseIndexBanner
          mode={mode}
          provider={provider}
          model={model}
          localReady={localReady}
        />
        <div className="relative z-10 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[0_8px_24px_rgba(0,0,0,0.35)] focus-within:border-[var(--border-focus)]">
          <ChatInput
            ref={inputRef}
            placeholder={
              disabled
                ? "Open a project to chat with its memory…"
                : "Ask about features, policies, changes…"
            }
            onChange={(v) => setHasText(v.trim().length > 0)}
            onSubmit={submit}
            enterToSend={enterToSend}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <ModeToggle
                mode={mode}
                localReady={localReady}
                providerReady={providerReady}
                onMode={(m) => setMode(sessionId, m)}
              />
              {mode === "provider" && (
                <ProviderModelSelector
                  configured={configured}
                  provider={provider}
                  model={model}
                  onProvider={(p) => setProvider(sessionId, p)}
                  onModel={(m) => setModel(sessionId, m)}
                />
              )}
              {mode === "local" && localReady && <BackendPill />}
            </div>
            {needsInstall ? (
              <InstallButton />
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!running && (!hasText || disabled || !canSend)}
                className={cn(
                  "flex items-center justify-center w-7 h-7 shrink-0 rounded-full transition-colors",
                  running
                    ? "bg-[var(--bg-elevated,var(--bg-tertiary))] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    : !hasText || disabled || !canSend
                      ? "bg-[var(--bg-elevated,var(--bg-tertiary))] text-[var(--text-tertiary)] cursor-not-allowed"
                      : "bg-[var(--text-primary)] text-[var(--bg-base)] hover:opacity-90",
                )}
                aria-label={running ? "Stop" : "Send"}
              >
                {running ? (
                  <Square size={11} strokeWidth={3} fill="currentColor" />
                ) : (
                  <ArrowUp size={14} strokeWidth={2.5} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Empty + setup gate ──────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="h-full grid place-items-center">
      <button
        onClick={onNew}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <Plus size={13} /> New memory chat
      </button>
    </div>
  );
}

/** Shown when neither a local model nor a provider is available. Offers both
 *  setup paths. Also renders the local-model download progress. */
function SetupGate({ byokLoaded }: { byokLoaded: boolean }) {
  const phase = useMemoryChatStore.use.modelPhase();
  const progress = useMemoryChatStore.use.modelProgress();
  const error = useMemoryChatStore.use.modelError();
  const { downloadModel } = useMemoryChatStore.use.actions();

  if (phase === "checking" || !byokLoaded) {
    return (
      <div className="h-full grid place-items-center">
        <Loader2 className="size-4 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  const pct =
    progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null;

  return (
    <div className="h-full grid place-items-center p-8">
      <div className="max-w-sm text-center space-y-3">
        <div className="mx-auto w-11 h-11 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-default)] grid place-items-center">
          <Sparkles size={22} className="text-[var(--text-tertiary)]" />
        </div>
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Chat with your codebase memory
          </p>
          <p className="text-xs text-[var(--text-tertiary)] mt-1.5 leading-relaxed">
            Ask about this project’s features, policies and changes. Run it on-device with a small
            local model (~470&nbsp;MB), or use one of your configured providers.
          </p>
        </div>

        {phase === "downloading" ? (
          <div className="space-y-1.5">
            <div className="h-1.5 rounded-full bg-[var(--bg-secondary)] overflow-hidden">
              <div
                className="h-full bg-[var(--accent-primary,#60a5fa)] transition-[width]"
                style={{ width: `${pct ?? 5}%` }}
              />
            </div>
            <p className="text-[10px] text-[var(--text-tertiary)]">
              Downloading Model
              {pct !== null ? `.. ${pct}%` : "…"}
            </p>
          </div>
        ) : phase === "loading" ? (
          <p className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
            <Loader2 size={12} className="animate-spin" /> Loading Model…
          </p>
        ) : (
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => void downloadModel()}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-border-default bg-bg-elevated text-text-primary text-xs font-medium hover:bg-bg-hover transition-colors shadow-[0_2px_8px_rgba(0,0,0,0.35)] cursor-pointer"
            >
              <Download size={12} /> Download local model
            </button>
            <button
              onClick={openProviderSettings}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-border-default bg-bg-elevated text-text-secondary text-xs font-medium hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
            >
              <KeyRound size={12} /> Set up a provider
            </button>
          </div>
        )}

        {phase === "download-failed" && (
          <p className="text-[11px] text-[var(--danger,#e5484d)]">{error ?? "Download failed"}</p>
        )}
      </div>
    </div>
  );
}
