import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronDown,
  ArrowUp,
  Square,
  KeyRound,
  Check,
  Loader2,
  Lock,
  Link2,
  PanelLeftOpen,
  Search,
  Paperclip,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  modelSupportsVision,
  imageMimeFromPath,
} from "../lib/model-capabilities";
import type { ComposerAttachment } from "../stores/model-chat-store";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { MessageItem } from "@/features/chat/components/message-item";
import { ChatSearchPalette } from "@/features/chat/components/chat-search-palette";
import { usePaneFind } from "@/features/chat/lib/use-pane-find";
import {
  ChatInput,
  type ChatInputHandle,
} from "@/features/chat/components/chat-input";
import {
  MentionPicker,
  type MentionPickerHandle,
} from "@/features/mentions/components/mention-picker";
import type { MentionTrigger } from "@/features/chat/lib/cm-mention-extension";
import type { MentionData } from "@/features/chat/lib/mentions";
import { ModelChatSidebar } from "./model-chat-sidebar";
import { ModelChatLinksPanel } from "./model-chat-links-panel";
import { ProviderLogo } from "@/components/provider-logo";
import {
  CHAT_PROVIDERS,
  providerById,
} from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useModelChatStore } from "../stores/model-chat-store";
import { modelchat } from "../lib/model-chat-api";

const JUMP_EVENT = "atlas:modelchat-jump";

// ── Model-list cache (P1) ───────────────────────────────────────────────────
// `modelchat.models(provider)` hit the provider API on every provider/session
// change and every tab remount, flashing "Loading…". Cache the id list per
// provider for the app session and dedupe in-flight requests.
const modelListCache = new Map<string, string[]>();
const modelListInFlight = new Map<string, Promise<string[]>>();
function loadModelIds(provider: string): Promise<string[]> {
  const cached = modelListCache.get(provider);
  if (cached) return Promise.resolve(cached);
  const inflight = modelListInFlight.get(provider);
  if (inflight) return inflight;
  const p = modelchat
    .models(provider)
    .then((list) => {
      const ids = list.map((m) => m.id);
      modelListCache.set(provider, ids);
      modelListInFlight.delete(provider);
      return ids;
    })
    .catch((e) => {
      modelListInFlight.delete(provider);
      throw e;
    });
  modelListInFlight.set(provider, p);
  return p;
}

// ── Virtualized-list height cache (P1) ──────────────────────────────────────
// Module-level so measured row heights survive remounts (tab switches), giving
// the virtualizer real sizes on first paint instead of snapping from estimate.
const mcHeights = new Map<string, number>();
let mcHeightSum = 0;
let mcHeightCount = 0;
const MC_DEFAULT_ROW = 96;
function mcRecordHeight(id: string, h: number) {
  const prev = mcHeights.get(id);
  if (prev === h) return;
  if (prev === undefined) {
    mcHeightCount += 1;
    mcHeightSum += h;
  } else {
    mcHeightSum += h - prev;
  }
  mcHeights.set(id, h);
}
function mcAverageHeight(): number {
  return mcHeightCount > 0
    ? Math.round(mcHeightSum / mcHeightCount)
    : MC_DEFAULT_ROW;
}

// `tabId` is the center-panel tab id — used to scope the Cmd+F finder to this
// pane. Model chat keeps its own session history independent of the tab.
export function ModelChatPanel({ tabId }: { tabId?: string } = {}) {
  const keys = useByokStore.use.keys();
  const loaded = useByokStore.use.loaded();
  const { load } = useByokStore.use.actions();
  const { init } = useModelChatStore.use.actions();

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    void init();
  }, [init]);

  const configured = useMemo(
    () => CHAT_PROVIDERS.filter((p) => !!keys[p.id]),
    [keys],
  );

  if (loaded && configured.length === 0) {
    return <EmptyState hasOtherKeys={Object.keys(keys).length > 0} />;
  }

  return (
    <ChatSurface tabId={tabId} configuredIds={configured.map((p) => p.id)} />
  );
}

function ChatSurface({
  tabId,
  configuredIds,
}: {
  tabId?: string;
  configuredIds: string[];
}) {
  const activeId = useModelChatStore.use.activeId();
  const streaming = useModelChatStore.use.streaming();
  const hasSession = useModelChatStore((s) =>
    activeId ? !!s.sessions[activeId] : false,
  );
  const { newSession } = useModelChatStore.use.actions();

  useEffect(() => {
    if (!activeId && configuredIds.length > 0) newSession(configuredIds[0], "");
  }, [activeId, configuredIds, newSession]);

  return (
    <div className="flex h-full bg-bg-base">
      <ModelChatSidebar onNew={() => newSession(configuredIds[0] ?? "", "")} />
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        {activeId && hasSession ? (
          <Conversation
            key={activeId}
            tabId={tabId}
            sessionId={activeId}
            configuredIds={configuredIds}
            isStreaming={!!streaming[activeId]}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-[12px] text-text-tertiary">
            Start a new chat
          </div>
        )}
      </div>
    </div>
  );
}

function Conversation({
  tabId,
  sessionId,
  configuredIds,
  isStreaming,
}: {
  tabId?: string;
  sessionId: string;
  configuredIds: string[];
  isStreaming: boolean;
}) {
  const session = useModelChatStore((s) => s.sessions[sessionId]);
  const { send, stop } = useModelChatStore.use.actions();
  const sidebar = useLayoutStore.use.modelChatSidebar();
  const { toggleModelChatSidebar } = useLayoutStore.use.actions();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Cmd+F find — scoped to this pane + tab (see usePaneFind).
  const [searchOpen, setSearchOpen] = usePaneFind(tabId);
  const [linksOpen, setLinksOpen] = useState(false);

  const messages = useMemo(() => session?.messages ?? [], [session]);

  // Virtualize the thread so a long BYOK chat doesn't mount every MessageItem
  // (each rendering block-level `StreamingMarkdown`) at once. Reuses the agent
  // chat's height-cache technique via a module-level map keyed by message id.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const id = messages[i]?.id;
      const cached = id ? mcHeights.get(id) : undefined;
      return cached ?? mcAverageHeight();
    },
    overscan: 10,
    getItemKey: (i) => messages[i]?.id ?? i,
    measureElement:
      typeof window !== "undefined" && !navigator.userAgent.includes("Firefox")
        ? (el) => {
            const h = Math.round(
              el?.getBoundingClientRect().height ?? mcAverageHeight(),
            );
            const id = el?.getAttribute("data-message-id");
            if (id) mcRecordHeight(id, h);
            return h;
          }
        : undefined,
  });

  // Jump-to-message (from search or the links panel). With virtualization the
  // target row may be unmounted, so scroll the virtualizer to it first, then
  // flash it once it's in the DOM.
  useEffect(() => {
    const handler = (e: Event) => {
      const idx = (e as CustomEvent<{ index: number }>).detail?.index;
      if (idx == null) return;
      virtualizer.scrollToIndex(idx, { align: "center" });
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector(`[data-mc-index="${idx}"]`);
        el?.classList.add("atlas-jump-flash");
        window.setTimeout(() => el?.classList.remove("atlas-jump-flash"), 1200);
      });
    };
    window.addEventListener(JUMP_EVENT, handler);
    return () => window.removeEventListener(JUMP_EVENT, handler);
  }, [virtualizer]);

  // Auto-scroll while near the bottom (covers both new messages and streaming
  // growth, since the store hands back a fresh messages array per delta).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isStreaming]);

  if (!session) return null;

  const jump = (index: number) =>
    window.dispatchEvent(new CustomEvent(JUMP_EVENT, { detail: { index } }));

  return (
    // `min-h-0` is REQUIRED on this flex-col (and its wrapper above): without it
    // the column's default `min-height: auto` lets it grow to the virtualizer's
    // full content height during a long streaming reply, which disables the
    // messages scroll and pushes the `shrink-0` composer off-screen.
    <div className="relative flex min-w-0 min-h-0 flex-1 flex-col">
      {/* Header bar — matches the agent chat (h-[32px]). */}
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-border-default">
        {!sidebar.visible && (
          <button
            onClick={toggleModelChatSidebar}
            className="flex items-center justify-center w-6 h-6 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Show history (⌘⌥K)"
          >
            <PanelLeftOpen size={13} />
          </button>
        )}
        {messages.length > 0 && (
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2 h-[26px] pl-2.5 pr-1 rounded-md border border-border-default bg-bg-elevated text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer outline-none transition-colors min-w-[280px]"
            title="Search messages (⌘F)"
          >
            <Search size={11} />
            <span>Find in chat…</span>
            <span className="ml-auto">
              <KbdGroup>
                <Kbd className="h-[16px] w-fit min-w-[16px]">⌘</Kbd>
                <Kbd className="h-[16px] w-fit min-w-[16px]">F</Kbd>
              </KbdGroup>
            </span>
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setLinksOpen((v) => !v)}
          className={cn(
            "flex items-center gap-1 px-2 h-6 rounded text-[10px] cursor-pointer outline-none transition-colors",
            linksOpen
              ? "text-text-primary bg-bg-selected"
              : "text-text-tertiary hover:text-text-primary hover:bg-bg-hover",
          )}
          title="Toggle links"
        >
          <Link2 size={11} />
          Links
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto [overflow-anchor:none]"
      >
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center px-6">
            <div className="max-w-[420px] text-center">
              <p className="text-[14px] font-medium text-text-primary">
                {providerById(session.provider)?.name ?? "Chat"}
              </p>
              <p className="mt-1 text-[12px] text-text-tertiary">
                Ask anything. Responses stream directly from the model using
                your stored key.
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[760px] px-4">
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const m = messages[vItem.index];
                return (
                  <div
                    key={m.id}
                    ref={virtualizer.measureElement}
                    data-index={vItem.index}
                    data-mc-index={vItem.index}
                    data-message-id={m.id}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <MessageAttachments messageId={m.id} />
                    <MessageItem
                      message={m}
                      model={m.role === "assistant" ? session.model : null}
                      streaming={
                        isStreaming &&
                        vItem.index === messages.length - 1 &&
                        m.role === "assistant"
                      }
                      isLastInGroup
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Composer
        sessionId={sessionId}
        configuredIds={configuredIds}
        running={isStreaming}
        onSend={(text, atts) => void send(sessionId, text, atts)}
        onStop={() => stop(sessionId)}
      />

      <ChatSearchPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        messages={messages}
        onJump={jump}
      />

      {linksOpen && (
        <ModelChatLinksPanel
          messages={messages}
          onClose={() => setLinksOpen(false)}
          onJump={(idx) => {
            setLinksOpen(false);
            jump(idx);
          }}
        />
      )}
    </div>
  );
}

function Composer({
  sessionId,
  configuredIds,
  running,
  onSend,
  onStop,
}: {
  sessionId: string;
  configuredIds: string[];
  running: boolean;
  onSend: (text: string, attachments?: ComposerAttachment[]) => void;
  onStop: () => void;
}) {
  const session = useModelChatStore((s) => s.sessions[sessionId]);
  const { setProvider, setModel } = useModelChatStore.use.actions();
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const provider = session?.provider ?? "";
  const model = session?.model ?? "";
  const providerLocked = (session?.messages.length ?? 0) > 0;
  const canAttach = modelSupportsVision(provider, model);

  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

  // Drop attachments if the user switches to a non-vision model.
  useEffect(() => {
    if (!canAttach && attachments.length) setAttachments([]);
  }, [canAttach, attachments.length]);

  const pickImages = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({
        multiple: true,
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        ],
      });
      const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
      const next: ComposerAttachment[] = [];
      for (const path of paths) {
        const mime = imageMimeFromPath(path);
        if (!mime) continue;
        const data = await invoke<string>("read_file_base64", { path });
        next.push({ mime, data, dataUrl: `data:${mime};base64,${data}` });
      }
      if (next.length) setAttachments((a) => [...a, ...next]);
    } catch (e) {
      toast.error(
        `Couldn't attach image: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const inputRef = useRef<ChatInputHandle>(null);
  // Mention/reference picker (reused from the agent chat; @ = all, ~ = notes).
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const triggerRef = useRef<MentionTrigger | null>(null);
  triggerRef.current = trigger;

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    const applyIds = (ids: string[]) => {
      if (cancelled) return;
      setModels(ids);
      const cur = useModelChatStore.getState().sessions[sessionId]?.model;
      if (!cur && ids.length > 0) setModel(sessionId, ids[0]);
    };

    // Cache hit → paint instantly, no spinner, no API call.
    const cached = modelListCache.get(provider);
    if (cached) {
      applyIds(cached);
      setLoadingModels(false);
      return;
    }

    setLoadingModels(true);
    loadModelIds(provider)
      .then(applyIds)
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, sessionId]);

  const handleMentionSelect = useCallback((mention: MentionData) => {
    const t = triggerRef.current;
    if (!t) return;
    inputRef.current?.insertMention(mention, t.from, t.to);
  }, []);

  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape" | "Backspace") => {
      const p = pickerRef.current;
      const t = triggerRef.current;
      if (!t || !p) return false;
      switch (key) {
        case "Up":
          p.moveUp();
          return true;
        case "Down":
          p.moveDown();
          return true;
        case "Enter":
          return p.commit();
        case "Escape":
          if (p.goBack()) return true;
          setTrigger(null);
          return true;
        case "Backspace":
          if (t.query === "" && p.goBack()) return true;
          return false;
      }
    },
    [],
  );

  const submit = () => {
    if (running) {
      onStop();
      return;
    }
    const text = inputRef.current?.getValue()?.trim() ?? "";
    if ((!text && attachments.length === 0) || !model) return;
    onSend(text, attachments.length ? attachments : undefined);
    inputRef.current?.clear();
    setHasText(false);
    setAttachments([]);
  };

  return (
    <div className="shrink-0 p-3">
      <div
        className={cn(
          "mx-auto w-full max-w-[760px] rounded-xl border border-border-default bg-bg-secondary",
          "shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-[border-color] duration-150",
          "focus-within:border-[var(--border-focus)]",
        )}
      >
        <ChatInput
          ref={inputRef}
          placeholder="Ask anything…  (@ to reference, ~ for notes)"
          onChange={(v) => setHasText(v.trim().length > 0)}
          onSubmit={submit}
          onMentionTrigger={setTrigger}
          keyInterceptor={keyInterceptor}
        />

        {/* Attached image thumbnails */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pb-1">
            {attachments.map((a, i) => (
              <div
                key={i}
                className="group relative h-12 w-12 overflow-hidden rounded-md border border-border-default"
              >
                <img
                  src={a.dataUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((arr) => arr.filter((_, j) => j !== i))
                  }
                  className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                >
                  <X size={9} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Control row: attach · provider + model pickers · send/stop */}
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            {canAttach && (
              <button
                type="button"
                onClick={() => void pickImages()}
                className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border border-border-default bg-bg-elevated text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                title="Attach image"
              >
                <Paperclip size={12} />
              </button>
            )}
            {providerLocked ? (
              <span
                className="flex items-center gap-1.5 h-[26px] rounded-full border border-border-default bg-bg-elevated px-2 text-[10px] font-medium text-text-secondary"
                title="Provider is locked for this chat"
              >
                <ProviderLogo id={provider} size={13} />
                <span className="max-w-[100px] truncate">
                  {providerById(provider)?.name ?? provider}
                </span>
                <Lock size={9} className="text-text-tertiary" />
              </span>
            ) : (
              <PickerDropdown
                trigger={
                  <>
                    <ProviderLogo id={provider} size={13} />
                    <span className="max-w-[100px] truncate">
                      {providerById(provider)?.name ?? provider}
                    </span>
                    <ChevronDown size={11} className="text-text-tertiary" />
                  </>
                }
              >
                {configuredIds.map((id) => (
                  <DropdownMenu.Item
                    key={id}
                    onSelect={() => setProvider(sessionId, id)}
                    className="flex items-center gap-2 px-2.5 h-[28px] text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none"
                  >
                    <ProviderLogo id={id} size={14} />
                    <span className="flex-1 truncate">
                      {providerById(id)?.name ?? id}
                    </span>
                    {id === provider && (
                      <Check size={12} className="text-text-primary" />
                    )}
                  </DropdownMenu.Item>
                ))}
              </PickerDropdown>
            )}

            <ModelCombo
              models={models}
              value={model}
              loading={loadingModels}
              onSelect={(id) => setModel(sessionId, id)}
            />
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={
              !running && ((!hasText && attachments.length === 0) || !model)
            }
            className={cn(
              "flex items-center justify-center w-7 h-7 shrink-0 rounded-full transition-colors",
              running
                ? "bg-bg-elevated text-text-secondary hover:text-text-primary cursor-pointer"
                : (!hasText && attachments.length === 0) || !model
                  ? "bg-bg-elevated text-text-tertiary cursor-not-allowed"
                  : "bg-[var(--text-primary)] text-[var(--bg-primary)] hover:bg-[var(--text-secondary)] cursor-pointer",
            )}
            aria-label={running ? "Stop" : "Send"}
          >
            {running ? (
              <Square size={11} strokeWidth={3} fill="currentColor" />
            ) : (
              <ArrowUp size={14} strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>

      <MentionPicker
        ref={pickerRef}
        open={trigger !== null}
        query={trigger?.query ?? ""}
        anchor={trigger?.anchor ?? null}
        initialScope={trigger?.scope ?? null}
        projectPath={projectPath}
        onSelect={handleMentionSelect}
        onClose={() => setTrigger(null)}
      />
    </div>
  );
}

/** Small pill-shaped dropdown used for the provider + model pickers. */
function PickerDropdown({
  trigger,
  children,
  wide,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex min-w-0 items-center gap-1.5 h-[26px] rounded-full border border-border-default bg-bg-elevated px-2 text-[10px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none cursor-pointer">
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={6}
          className={cn(
            "z-[9999] max-h-[340px] overflow-y-auto rounded-md border border-border-default bg-bg-elevated py-1 shadow-[var(--shadow-overlay)]",
            wide ? "min-w-[240px]" : "min-w-[180px]",
          )}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Searchable model picker — a combobox with a filter input on top. */
function ModelCombo({
  models,
  value,
  loading,
  onSelect,
}: {
  models: string[];
  value: string;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? models.filter((m) => m.toLowerCase().includes(s)) : models;
  }, [models, q]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <Popover.Trigger asChild>
        <button className="flex min-w-0 items-center gap-1.5 h-[26px] rounded-full border border-border-default bg-bg-elevated px-2 text-[10px] font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors outline-none cursor-pointer">
          {loading && (
            <Loader2 size={11} className="animate-spin text-text-tertiary" />
          )}
          <span className="max-w-[200px] truncate font-mono">
            {value || (loading ? "Loading…" : "Select model")}
          </span>
          <ChevronDown size={11} className="text-text-tertiary" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          className="z-[9999] w-[260px] overflow-hidden rounded-md border border-border-default bg-bg-elevated shadow-[var(--shadow-overlay)]"
        >
          <div className="flex items-center gap-1.5 h-8 border-b border-border-subtle px-2.5">
            <Search size={12} className="shrink-0 text-text-tertiary" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto hide-scrollbar py-1">
            {filtered.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] text-text-tertiary">
                {loading ? "Loading…" : "No models"}
              </div>
            ) : (
              filtered.map((id) => (
                <button
                  key={id}
                  onClick={() => {
                    onSelect(id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 h-[26px] text-left text-[11px] font-mono text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none"
                >
                  <span className="flex-1 truncate">{id}</span>
                  {id === value && (
                    <Check size={11} className="text-text-primary" />
                  )}
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Thumbnails for images attached to a user message (transient, in-memory). */
function MessageAttachments({ messageId }: { messageId: string }) {
  const urls = useModelChatStore((s) => s.attachmentsByMsg[messageId]);
  if (!urls?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-2 pt-4">
      {urls.map((u, i) => (
        <img
          key={i}
          src={u}
          alt=""
          className="max-h-44 rounded-lg border border-border-default object-contain"
        />
      ))}
    </div>
  );
}

function EmptyState({ hasOtherKeys }: { hasOtherKeys: boolean }) {
  const openSettings = () => {
    void import("@/features/layout/stores/layout-store").then(
      ({ useLayoutStore }) => {
        useLayoutStore.getState().actions.addTab({
          id: "settings",
          type: "settings",
          title: "Settings",
          closable: true,
          dirty: false,
          data: { section: "providers" },
        });
      },
    );
  };
  return (
    <div className="grid h-full place-items-center bg-bg-base p-6">
      <div className="max-w-[380px] text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-border-default bg-bg-elevated">
          <KeyRound size={20} className="text-text-tertiary" />
        </div>
        <p className="mt-3 text-[13px] font-medium text-text-primary">
          {hasOtherKeys
            ? "No chat-capable provider yet"
            : "No provider keys yet"}
        </p>
        <p className="mt-1 text-[11px] text-text-tertiary">
          {hasOtherKeys
            ? "Your saved keys are for providers that don't support chat. Add a chat provider — OpenAI, Anthropic, Google, Mistral, Groq, … — to start."
            : "Add an API key for a chat provider (OpenAI, Anthropic, Google, Groq, …) to start chatting with models directly."}
        </p>
        <button
          onClick={openSettings}
          className="mt-3 inline-flex items-center gap-1.5 h-7 rounded-md bg-[var(--accent-primary)] px-3 text-[11px] font-medium text-[var(--bg-base)] hover:opacity-90 transition-opacity"
        >
          <KeyRound size={12} />
          Open API Keys
        </button>
      </div>
    </div>
  );
}
