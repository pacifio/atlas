/**
 * Session Chat — the right half of the split, grounded in one recorded Session.
 * Props-only: `session-chat-panel.tsx` reads the stores and fills the slots.
 *
 * What is particular to this panel is the *framing*: a header that says which
 * Session you are asking about and which agent recorded it, and a thread picker
 * scoped to that Session. The editor, the model picker, the scope strip and the
 * turns arrive as slots, so this file draws chrome and nothing else.
 */

import { useMemo, useState, type ReactNode, type Ref } from "react";
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
import {
  Button,
  Hint,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@tryatlas/design";

import { AtlasIcon } from "@/components/brand-marks";
import { cn } from "@/lib/utils";

/**
 * The questions worth putting in front of someone who has never used this.
 *
 * Deliberately the four the retriever is *strongest* at — each is answered
 * mostly from the always-present brief rather than from ranking, so a first
 * impression does not depend on a lucky match.
 */
export const STARTERS = [
  { text: "What changed in this session?", Icon: GitCompare },
  { text: "Review this session like a PR", Icon: ClipboardCheck },
  { text: "What was each commit for?", Icon: GitCommitHorizontal },
  { text: "Diagram what this touched", Icon: Workflow },
] as const;

export interface SessionChatThreadMeta {
  id: string;
  title: string;
  /** "3m", already formatted. */
  updatedLabel: string;
}

export interface SessionChatPanelViewProps {
  /** The active thread's title. */
  title: string;
  metas: SessionChatThreadMeta[];
  activeId: string | null;
  /** Which agent recorded the Session, and its mark. */
  agentBadge: { agent: string; glyph: ReactNode } | null;
  /**
   * `loading`: provider keys are still being read (renders nothing, so the
   * "needs a key" copy never flashes). `needs-key`: no provider is set up.
   * `starters`: the thread is empty. `thread`: draw `messages`.
   */
  state: "loading" | "needs-key" | "starters" | "thread";
  startersDisabled: boolean;
  messages: ReactNode;
  error: string | null;
  composer: ReactNode | null;
  /** The scroller, and the content inside it: the container sticks to the
   *  bottom by watching the second and moving the first. */
  scrollRef: Ref<HTMLDivElement>;
  contentRef: Ref<HTMLDivElement>;
  onScroll: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onPickStarter: (question: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

export function SessionChatPanelView({
  title,
  metas,
  activeId,
  agentBadge,
  state,
  startersDisabled,
  messages,
  error,
  composer,
  scrollRef,
  contentRef,
  onScroll,
  onSelect,
  onNew,
  onDelete,
  onPickStarter,
  onOpenSettings,
  onClose,
}: SessionChatPanelViewProps) {
  return (
    <div
      data-slot="session-chat-panel"
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <ThreadPicker
          title={title}
          metas={metas}
          activeId={activeId}
          onSelect={onSelect}
          onNew={onNew}
          onDelete={onDelete}
        />
        <div className="flex-1" />
        {/* Which agent recorded the Session being discussed — the chat is about
         *  its work, not about the model answering. */}
        {agentBadge && (
          <span
            title={`Recorded by ${agentBadge.agent}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground"
          >
            {agentBadge.glyph}
          </span>
        )}
        <Hint label="Close chat">
          <IconButton variant="ghost" size="sm" icon={X} label="Close chat" onClick={onClose} />
        </Hint>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="hide-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex min-h-full flex-col">
          {state === "needs-key" ? (
            <NeedsKey onOpenSettings={onOpenSettings} />
          ) : state === "starters" ? (
            <Starters disabled={startersDisabled} onPick={onPickStarter} />
          ) : state === "thread" ? (
            messages
          ) : null}
        </div>
      </div>

      {error && (
        <p className="shrink-0 border-t border-error/25 bg-error-muted px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      {composer}
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
  metas: SessionChatThreadMeta[];
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
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="min-w-0">
            <span className="truncate text-foreground">{title}</span>
            <Icon icon={ChevronDown} size="sm" className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align="start" sideOffset={6} className="w-[280px] p-0">
        <div className="flex max-h-[380px] flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2.5">
            <Icon icon={Search} size="sm" className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a chat…"
              aria-label="Find a chat"
              spellCheck={false}
              autoFocus
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                {metas.length === 0 ? "No chats yet." : "No match."}
              </p>
            ) : (
              filtered.map((meta) => (
                <div
                  key={meta.id}
                  className="group/thread flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-element-hover"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(meta.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  >
                    <span
                      className={cn(
                        "flex shrink-0",
                        meta.id === activeId ? "text-foreground" : "opacity-0",
                      )}
                    >
                      <Icon icon={Check} size="xs" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">
                      {meta.title}
                    </span>
                    <span className="shrink-0 font-mono text-2xs text-disabled">
                      {meta.updatedLabel}
                    </span>
                  </button>
                  {/* Revealed with its row, or as focus reaches it. Deleting
                   *  keeps the list open, so several can go in a row. */}
                  <span className="flex opacity-0 transition-opacity group-hover/thread:opacity-100 focus-within:opacity-100">
                    <Hint label="Delete chat">
                      <IconButton
                        variant="ghost-destructive"
                        size="xs"
                        icon={Trash2}
                        label="Delete chat"
                        onClick={() => onDelete(meta.id)}
                      />
                    </Hint>
                  </span>
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
            className="flex h-8 shrink-0 cursor-pointer items-center gap-2 border-t border-border px-2.5 text-sm text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
          >
            <Icon icon={Plus} size="sm" />
            New chat
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Empty states ─────────────────────────────────────────────────────────────

function NeedsKey({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-base text-secondary-foreground">
        Chatting with a session needs an API key.
      </p>
      <p className="text-sm text-muted-foreground">
        Everything else runs locally — the session is read from your own store and the question is
        answered by the provider you choose.
      </p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onOpenSettings}>
        Add a key in Settings
      </Button>
    </div>
  );
}

/**
 * The first thing you see.
 *
 * Mirrors the agent chat's welcome — mark, name, one line of purpose, then four
 * cards — because it is the same gesture in a different surface, and an empty
 * panel that looks like a different product for no reason is just friction.
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
              background: "radial-gradient(circle, var(--primary) 0%, transparent 68%)",
            }}
          />
          <AtlasIcon size={48} className="atlas-fade-in rounded-xl shadow-lg ring-1 ring-border" />
        </div>

        <h2
          className="atlas-fade-in bg-gradient-to-b from-foreground to-foreground/55 bg-clip-text text-xl font-semibold tracking-tight text-transparent"
          style={{ animationDelay: "40ms" }}
        >
          Ask this session
        </h2>
        <p
          className="atlas-fade-in mt-1.5 text-sm text-muted-foreground"
          style={{ animationDelay: "80ms" }}
        >
          Grounded in what this session actually recorded.
        </p>

        <div className="mt-6 grid w-full grid-cols-2 gap-2">
          {STARTERS.map(({ text, Icon: Glyph }, i) => (
            <button
              key={text}
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              style={{ animationDelay: `${120 + i * 50}ms` }}
              className={cn(
                "group atlas-fade-in flex flex-col gap-2 rounded-xl border border-border bg-card p-2.5 text-left transition-[translate,background-color,border-color,box-shadow,opacity] duration-150",
                disabled
                  ? "cursor-default opacity-50"
                  : "cursor-pointer hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="grid size-6 place-items-center rounded-lg border border-border-subtle bg-card text-muted-foreground transition-colors group-hover:text-foreground">
                  <Icon icon={Glyph} size="sm" />
                </span>
                <span className="flex -translate-x-1 text-disabled opacity-0 transition-[translate,color,opacity] group-hover:translate-x-0 group-hover:text-secondary-foreground group-hover:opacity-100">
                  <Icon icon={ArrowRight} size="sm" />
                </span>
              </div>
              <span className="text-sm font-medium text-secondary-foreground transition-colors group-hover:text-foreground">
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

export interface SessionChatComposerViewProps {
  /** The editor. */
  input: ReactNode;
  modelPicker: ReactNode;
  /** The tucked strip stating what the next question will read. */
  scopePicker: ReactNode;
  running: boolean;
  /** There is text and a model is ready. */
  canSend: boolean;
  /** Sends, or stops while `running`. */
  onSubmit: () => void;
}

export function SessionChatComposerView({
  input,
  modelPicker,
  scopePicker,
  running,
  canSend,
  onSubmit,
}: SessionChatComposerViewProps) {
  const enabled = running || canSend;
  return (
    <div className="shrink-0 p-3">
      {/* Tucked header stating what the NEXT question will read. It sits
          BEHIND the box below (`z-0` vs `z-10`) with only its curved top
          showing — the same construction as Memory ▸ Chat's codebase strip. */}
      {scopePicker}
      {/* `relative z-10` is load-bearing: the strip above is positioned, and
          positioned elements paint over non-positioned siblings regardless of
          DOM order — without this the strip would cover the composer. */}
      <div className="relative z-10 overflow-hidden rounded-xl border border-border bg-card shadow-sm focus-within:border-border-strong">
        {input}
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          {modelPicker}
          <Hint label={running ? "Stop" : "Send"}>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!enabled}
              aria-label={running ? "Stop" : "Send"}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
                running
                  ? "cursor-pointer bg-card text-secondary-foreground hover:text-foreground"
                  : !canSend
                    ? "cursor-not-allowed bg-card text-muted-foreground"
                    : "cursor-pointer bg-foreground text-background hover:opacity-90",
              )}
            >
              {/* Updates in place: Enter sends, so the arrow↔stop swap is
                  keyboard-driven and has no animation. */}
              {running ? (
                <Icon icon={Square} size="xs" strokeWidth={3} fill="currentColor" />
              ) : (
                <Icon icon={ArrowUp} size="md" strokeWidth={2.5} />
              )}
            </button>
          </Hint>
        </div>
      </div>
    </div>
  );
}
