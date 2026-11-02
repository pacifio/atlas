// One conversation with the Organisation agent: its messages and the
// composer under them. Shared by the side panel, the floating messenger and
// the full page, so a conversation reads the same wherever it is — only the
// measure changes.
//
// Data-driven, like the coding agent's thread: an answer draws exactly what
// the server says about it and nothing it does not — how long the agent
// thought, the sources it read — then the answer as prose on the page, then
// what you can do with it (copy, rate, ask again). Your question is the coding
// chat's bubble.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { BorderBeam } from "border-beam";
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderKanban,
  Gauge,
  Lightbulb,
  MessageSquare,
  MessagesSquare,
  RotateCcw,
  Telescope,
  ThumbsDown,
  ThumbsUp,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useAuthStore } from "@/features/auth/stores/auth-store";
import { ChatInput, type ChatInputHandle } from "@/features/chat/components/chat-input";
import { useComposerFold } from "@/features/chat/hooks/use-composer-fold";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { copyText } from "@/lib/clipboard";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";

import {
  ORG_AGENT_DAILY_LIMIT,
  ORG_AGENT_DEEP_RESEARCH_DAILY,
  type OrgAgentConversation,
  type OrgAgentEffort,
  type OrgAgentMessage,
  type OrgAgentSource,
} from "../lib/org-agent-api";
import { usageToday, useOrgAgentStore } from "../stores/org-agent-store";

/** The starters: the web's three, and the one a team lead asks first. */
const STARTERS: { text: string; Icon: LucideIcon }[] = [
  { text: "What did I work on this week?", Icon: CalendarDays },
  { text: "What is the team working on today?", Icon: Users },
  { text: "Which of my sessions have open comments?", Icon: MessageSquare },
  { text: "Summarise this week's team chat", Icon: MessagesSquare },
];

const SOURCE_ICON: Record<OrgAgentSource["kind"], LucideIcon> = {
  session: FileText,
  project: FolderKanban,
  comment: MessageSquare,
  chat: MessagesSquare,
  page: FileText,
};

const EFFORTS: { value: OrgAgentEffort; label: string; hint: string }[] = [
  { value: "low", label: "Low", hint: "Quick answers from what is at hand" },
  { value: "medium", label: "Medium", hint: "Reads around before answering" },
  { value: "high", label: "High", hint: "Takes its time, reads widely" },
];

export function OrgAgentThread({
  conversation,
  size,
  topInset,
  autoFocus,
}: {
  conversation: OrgAgentConversation;
  /** `compact` in the side panel and the messenger, `page` full page. */
  size: "compact" | "page";
  /** A header floating over the top (any CSS length): the content starts
   *  below it and its blur band, and scrolls up under both. */
  topInset?: string;
  autoFocus?: boolean;
}) {
  const pending = useOrgAgentStore((s) => s.pending.includes(conversation.id));
  const { send } = useOrgAgentStore.use.actions();
  const scroller = useRef<HTMLDivElement>(null);
  const page = size === "page";
  const measure = page ? "mx-auto w-full max-w-[760px] px-6" : "px-4";

  // Follow the end: a new message, or the answer landing.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.messages.length, pending]);

  const empty = conversation.messages.length === 0;
  const lastAnswer = [...conversation.messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="hide-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto"
        // Past the header and its blur band, or the first message sits under
        // the bar, permanently blurred.
        style={topInset ? { paddingTop: `calc(${topInset} + ${page ? 34 : 8}px)` } : undefined}
      >
        {empty ? (
          <Welcome onPick={(q) => send(conversation.id, q)} />
        ) : (
          <div className={cn(measure, "flex flex-col gap-6", page ? "py-8" : "py-5")}>
            {conversation.messages.map((m) =>
              m.role === "user" ? (
                <Question key={m.id} message={m} />
              ) : (
                <Answer
                  key={m.id}
                  conversationId={conversation.id}
                  message={m}
                  last={m.id === lastAnswer?.id && !pending}
                />
              ),
            )}
            {pending && <Thinking />}
          </div>
        )}
      </div>
      <div
        className={cn("shrink-0", page ? "mx-auto w-full max-w-[760px] px-6 pb-5" : "px-3 pb-3")}
      >
        <Composer
          compact={!page}
          working={pending}
          autoFocus={autoFocus}
          onSend={(text) => send(conversation.id, text)}
        />
      </div>
    </div>
  );
}

// ── The empty conversation ──────────────────────────────────────────────────

/** The coding agent's welcome (`chat-panel.tsx`), asked of the Organisation:
 *  the greeting, the question, and four places to start — stacked, so each
 *  reads as a whole sentence at the side panel's width. */
function Welcome({ onPick }: { onPick: (question: string) => void }) {
  const snapshot = useAuthStore.use.snapshot();
  const firstName =
    snapshot.status === "signed-in" ? snapshot.user?.name.trim().split(/\s+/)[0] : undefined;
  const greeting = firstName ? `Hi, ${firstName} 👋` : "Welcome back 👋";

  return (
    <div className="flex flex-1 items-center justify-center px-5 py-8">
      <div className="flex w-full max-w-[440px] flex-col items-start">
        <p className="text-lg text-muted-foreground">{greeting}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
          What do you want to know?
        </h2>
        <div className="mt-10 flex w-full flex-col gap-2">
          {STARTERS.map(({ text, Icon }) => (
            <button
              key={text}
              type="button"
              onClick={() => onPick(text)}
              className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-2.5 text-left transition-all duration-150 hover:border-border-strong hover:bg-muted"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border-subtle bg-card text-muted-foreground transition-colors group-hover:text-foreground">
                <Icon size={13} />
              </span>
              <span className="min-w-0 flex-1 text-sm leading-snug font-medium text-secondary-foreground transition-colors group-hover:text-foreground">
                {text}
              </span>
              <ArrowRight
                size={12}
                className="shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Messages ────────────────────────────────────────────────────────────────

function Question({ message }: { message: OrgAgentMessage }) {
  return (
    <div className="flex justify-end pl-10">
      <div
        className={cn(
          // The coding chat's bubble (`transcript-rows.tsx`).
          // ratchet-allow: 20px sits above the `rounded-*` scale (xl = 12px), and a
          // full radius would turn a many-line bubble into an ellipse.
          "min-w-0 max-w-full rounded-[20px] bg-[var(--atlas-primary-muted)] px-4 py-2.5 select-text",
        )}
      >
        <CachedMarkdown source={message.text} unstyled className="atlas-prose atlas-prose--user" />
      </div>
    </div>
  );
}

function Answer({
  conversationId,
  message,
  last,
}: {
  conversationId: string;
  message: OrgAgentMessage;
  /** The newest answer: the only one that can be asked again. */
  last: boolean;
}) {
  const { setFeedback, retry } = useOrgAgentStore.use.actions();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const thought =
    message.thoughtMs !== undefined ? Math.max(1, Math.round(message.thoughtMs / 1000)) : null;
  const sources = message.sources ?? [];

  return (
    <div className="flex flex-col gap-2">
      {(thought !== null || sources.length > 0) && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {thought !== null ? (
            <span className="flex items-center gap-1.5">
              <Lightbulb size={12} />
              Thought for {thought} {thought === 1 ? "second" : "seconds"}
              <ChevronRight size={11} />
            </span>
          ) : (
            <span />
          )}
          {sources.length > 0 && <Sources sources={sources} />}
        </div>
      )}
      <div className="min-w-0 select-text">
        <CachedMarkdown source={message.text} unstyled className="atlas-prose" />
      </div>
      <HintGroup side="bottom">
        <div className="-ml-1.5 flex items-center gap-0.5 text-muted-foreground">
          <Action
            label={copied ? "Copied" : "Copy"}
            icon={copied ? Check : Copy}
            onClick={() => void copyText(message.text).then(setCopied)}
          />
          <Action
            label="Good answer"
            icon={ThumbsUp}
            on={message.feedback === "up"}
            onClick={() =>
              setFeedback(conversationId, message.id, message.feedback === "up" ? null : "up")
            }
          />
          <Action
            label="Bad answer"
            icon={ThumbsDown}
            on={message.feedback === "down"}
            onClick={() =>
              setFeedback(conversationId, message.id, message.feedback === "down" ? null : "down")
            }
          />
          {last && (
            <Action label="Ask again" icon={RotateCcw} onClick={() => retry(conversationId)} />
          )}
        </div>
      </HintGroup>
    </div>
  );
}

function Action({
  label,
  icon: Glyph,
  on,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  on?: boolean;
  onClick: () => void;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={on}
        onClick={onClick}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors duration-fast hover:bg-element-hover hover:text-foreground",
          on && "text-foreground",
        )}
      >
        <Glyph size={13} fill={on ? "currentColor" : "none"} />
      </button>
    </HintItem>
  );
}

/** "N sources", their glyphs stacked, opening the list of what was read. */
function Sources({ sources }: { sources: OrgAgentSource[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card py-0.5 pr-2 pl-1 transition-colors hover:text-foreground"
          >
            <span className="flex -space-x-1">
              {sources.slice(0, 3).map((source, i) => {
                const Glyph = SOURCE_ICON[source.kind] ?? FileText;
                return (
                  <span
                    key={i}
                    className="grid size-4 place-items-center rounded-full bg-element-active ring-1 ring-card"
                  >
                    <Glyph size={9} />
                  </span>
                );
              })}
            </span>
            {sources.length} {sources.length === 1 ? "source" : "sources"}
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={6}>
          <Popover.Popup className="w-[260px] origin-[var(--transform-origin)] overflow-hidden rounded-xl border border-border bg-background p-1 text-foreground shadow-lg data-closed:animate-scale-out data-open:animate-scale-in">
            {sources.map((source, i) => {
              const Glyph = SOURCE_ICON[source.kind] ?? FileText;
              return (
                <a
                  key={i}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
                >
                  <Glyph size={12} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{source.title}</span>
                </a>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Thinking() {
  return (
    <div
      className="flex animate-pulse items-center gap-1.5 text-sm text-muted-foreground"
      aria-live="polite"
    >
      <Lightbulb size={12} />
      Thinking…
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

/** The capsule's radius: half the card's 46px (44px of field and a 1px rim
 *  either side), the coding composer's `rounded-composer`. */
const CAPSULE_RADIUS = 23;
const CARD_RADIUS = 12;

/** The coding composer's tray pill (`message-input.tsx`). */
function pill(on: boolean): string {
  return cn(
    "flex h-6.5 cursor-pointer items-center gap-1 rounded-full border px-2 text-2xs leading-none font-medium transition-colors",
    "disabled:cursor-not-allowed disabled:opacity-50",
    on
      ? "border-[var(--atlas-border-strong)] bg-[var(--atlas-element-selected)] text-[var(--foreground)]"
      : "border-[var(--border)] bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
  );
}

/**
 * The coding agent's composer (`message-input.tsx`), built from its own
 * parts: the same editor (`ChatInput`), the same input card — a capsule while
 * it is empty and away, a card while in use, the corner easing between — the
 * same send button pinned in its corner, and the same toolbar tray tucked
 * under it, folding away behind the card (`use-composer-fold.ts`). Only the
 * tray's contents are the agent's: mention, effort and deep research, and
 * today's count. While the agent works, a beam rides the card's bottom edge
 * (libraries.dev's `border-beam`).
 */
function Composer({
  compact,
  working,
  autoFocus,
  onSend,
}: {
  /** The side panel's and the messenger's width: a lighter tray. */
  compact: boolean;
  working: boolean;
  autoFocus?: boolean;
  onSend: (text: string) => void;
}) {
  const input = useRef<ChatInputHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);
  const [focused, setFocused] = useState(false);
  const appearance = useAppearance();
  const collapsed = empty && !focused;
  const trayShown = useComposerFold(collapsed, card, tray);
  const enterToSend = useSettingsStore((s) => s.settings.enterToSend);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const text = input.current?.getValue().trim() ?? "";
    if (!text || working) return;
    onSend(text);
    input.current?.clear();
  };

  // What folds it, as in the coding composer (`message-input.tsx`): focus
  // moving to something ELSE, a press outside it, or Esc. Not focus merely
  // dropping to <body> — WebKit does not focus a pressed button, so that
  // would fold the tray out from under its own pill. Never while one of its
  // menus is open (they live in a portal), nor when the window lost focus.
  const menuOpen = () => !!root.current?.querySelector("[data-popup-open], [aria-expanded='true']");
  const onBlur = () =>
    requestAnimationFrame(() => {
      if (!document.hasFocus()) return;
      const el = root.current;
      const active = document.activeElement;
      if (!el || !active || active === document.body) return;
      if (el.contains(active) || menuOpen()) return;
      setFocused(false);
    });
  useEffect(() => {
    if (!focused) return;
    const onPointerDown = (event: PointerEvent) => {
      const el = root.current;
      if (!el || !(event.target instanceof Node) || el.contains(event.target)) return;
      if (menuOpen()) return;
      setFocused(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [focused]);

  return (
    <div
      ref={root}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={onBlur}
      onPointerDownCapture={() => setFocused(true)}
      // A press on the composer's own surface keeps focus where it is.
      onMouseDown={(e) => {
        const target = e.target as Element;
        if (
          !target.closest("button, a, input, textarea, [contenteditable='true'], [role='button']")
        ) {
          e.preventDefault();
        }
      }}
      onKeyDownCapture={(e) => {
        if (e.key !== "Escape" || !empty) return;
        if (menuOpen()) return;
        (document.activeElement as HTMLElement | null)?.blur();
        setFocused(false);
      }}
    >
      <div ref={card} className="relative z-10 mx-1 mt-1">
        <BorderBeam
          size="line"
          colorVariant="mono"
          theme={appearance}
          active={working}
          borderRadius={collapsed ? CAPSULE_RADIUS : CARD_RADIUS}
        >
          <div
            className={cn(
              "relative min-h-[44px] border border-[var(--border)] bg-[var(--background)] shadow-sm",
              collapsed ? "rounded-composer" : "rounded-xl",
              "transition-[border-radius,border-color,box-shadow] duration-base ease-out-strong motion-reduce:transition-none",
              "focus-within:border-[color-mix(in_srgb,var(--atlas-border-strong)_50%,var(--border))]",
              "focus-within:ring-1 focus-within:ring-[var(--primary)]/10",
            )}
          >
            <div className="pr-[40px]">
              <ChatInput
                ref={input}
                placeholder="Ask Atlas about your team's work…"
                enterToSend={enterToSend}
                onSubmit={submit}
                onEmptyChange={setEmpty}
              />
            </div>
            {/* No wrapping span: it would sit in flow under the absolute
                button and grow the card. */}
            <Hint side="top" wrap={false} label="Send">
              <button
                type="button"
                onClick={submit}
                disabled={empty || working}
                aria-label="Send"
                // The coding composer's send, in px: centred on the first
                // line at any UI scale.
                className={cn(
                  "absolute top-[8px] right-[8px] flex h-[28px] w-[28px] items-center justify-center rounded-lg border transition-colors",
                  empty || working
                    ? "cursor-not-allowed border-transparent text-[var(--muted-foreground)]"
                    : "cursor-pointer border-transparent text-[var(--foreground)] hover:border-[var(--border)] hover:bg-[var(--atlas-element-hover)]",
                )}
              >
                <ArrowUp size={15} strokeWidth={2.5} />
              </button>
            </Hint>
          </div>
        </BorderBeam>
      </div>
      <div ref={tray} hidden={!trayShown}>
        <div
          inert={collapsed}
          className="mx-5 flex items-center justify-between gap-2 rounded-b-xl border border-t-0 border-[var(--border)] bg-[var(--atlas-panel-input-background)] px-2 pt-2 pb-1.5"
        >
          <Tray compact={compact} onMention={() => input.current?.insertText("@")} />
        </div>
      </div>
    </div>
  );
}

/** The tray's contents: mention, effort and deep research on the left;
 *  today's count on the right. */
function Tray({ compact, onMention }: { compact: boolean; onMention: () => void }) {
  const effort = useOrgAgentStore.use.effort();
  const deepResearch = useOrgAgentStore.use.deepResearch();
  const conversations = useOrgAgentStore.use.conversations();
  const { setEffort, setDeepResearch } = useOrgAgentStore.use.actions();
  const [open, setOpen] = useState(false);
  const { asked, deep } = usageToday(conversations);
  const deepLeft = Math.max(0, ORG_AGENT_DEEP_RESEARCH_DAILY - deep);
  const current = EFFORTS.find((e) => e.value === effort) ?? EFFORTS[1];

  const deepPill = (
    <HintItem
      label={
        deepLeft > 0
          ? `Deep Research: ${deepLeft} of ${ORG_AGENT_DEEP_RESEARCH_DAILY} left today`
          : "No Deep Research left today"
      }
    >
      <button
        type="button"
        aria-pressed={deepResearch}
        disabled={deepLeft === 0 && !deepResearch}
        onClick={() => setDeepResearch(!deepResearch)}
        className={pill(deepResearch)}
      >
        <Telescope size={11} />
        Deep Research
        <span className="tabular-nums text-[var(--muted-foreground)]">{deepLeft}</span>
      </button>
    </HintItem>
  );

  return (
    <>
      <HintGroup side="top">
        <div className="flex min-w-0 items-center gap-1">
          <HintItem label="Mention a session, project or person">
            <button
              type="button"
              aria-label="Mention a session, project or person"
              onClick={onMention}
              className={cn(pill(false), "w-6.5 justify-center px-0")}
            >
              <AtSign size={12} />
            </button>
          </HintItem>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger
              render={
                <button type="button" className={pill(false)}>
                  <Gauge size={11} />
                  {current.label}
                  <ChevronDown size={10} />
                </button>
              }
            />
            <Popover.Portal>
              <Popover.Positioner className="z-popover" side="top" align="start" sideOffset={6}>
                <Popover.Popup className="w-[240px] origin-[var(--transform-origin)] overflow-hidden rounded-xl border border-border bg-background p-1 text-foreground shadow-lg data-closed:animate-scale-out data-open:animate-scale-in">
                  {EFFORTS.map((e) => (
                    <button
                      key={e.value}
                      type="button"
                      onClick={() => {
                        setEffort(e.value);
                        setOpen(false);
                      }}
                      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-element-hover"
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                        {e.value === effort && <Check size={12} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{e.label}</span>
                        <span className="block text-xs text-muted-foreground">{e.hint}</span>
                      </span>
                    </button>
                  ))}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          {!compact && deepPill}
        </div>
        {/* At the side panel's width, today's count gives way: Deep
            Research takes the right end on its own. */}
        {compact ? (
          deepPill
        ) : (
          <span className="shrink-0 text-2xs text-[var(--muted-foreground)] tabular-nums">
            {asked} of {ORG_AGENT_DAILY_LIMIT} today
          </span>
        )}
      </HintGroup>
    </>
  );
}

/** The page's appearance, for the beam's own light/dark tuning. */
function useAppearance(): "dark" | "light" {
  const [appearance, setAppearance] = useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    const update = () =>
      setAppearance(document.documentElement.classList.contains("dark") ? "dark" : "light");
    window.addEventListener("atlas:theme-applied", update);
    return () => window.removeEventListener("atlas:theme-applied", update);
  }, []);
  return appearance;
}
