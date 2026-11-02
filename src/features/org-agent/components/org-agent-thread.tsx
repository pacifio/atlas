// One conversation with the Organisation agent: its turns and the composer
// under them. Shared by the side panel, the floating messenger and the full
// page, so a conversation reads the same wherever it is — only the measure
// changes.
//
// Drawn from the conversation's event log on the server
// (`org-agent-log.ts`): every turn exactly as the server recorded it — the
// tools Atlas ran and the records they returned, the approvals it asked for,
// the answer streaming in — so this window, another window and the web all
// show the same thing.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { BorderBeam } from "border-beam";
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  CalendarDays,
  Check,
  ChevronDown,
  Gauge,
  MessageSquare,
  MessagesSquare,
  Square,
  Telescope,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useComposerFold } from "@/features/chat/hooks/use-composer-fold";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";

import { handleIndex, type OrgAgentTarget } from "../lib/org-agent-links";
import { durationWords, foldAsk, lastOf } from "../lib/org-agent-log";
import { openTarget } from "../lib/org-agent-navigate";
import { ATLAS_EFFORTS, type AtlasEffort } from "../lib/org-agent-types";
import {
  askBusy,
  askWaiting,
  isTempAsk,
  pendingFor,
  useOrgAgentStore,
} from "../stores/org-agent-store";
import { OrgAgentInput, type OrgAgentInputHandle } from "./org-agent-input";
import { Notice, PendingTurn, TurnView } from "./org-agent-turn";

/** The starters: the web's three, and the one a team lead asks first. */
const STARTERS: { text: string; Icon: LucideIcon }[] = [
  { text: "What did I work on this week?", Icon: CalendarDays },
  { text: "What is the team working on today?", Icon: Users },
  { text: "Which of my sessions have open comments?", Icon: MessageSquare },
  { text: "Summarise this week's team chat", Icon: MessagesSquare },
];

/** The levels before the server has said: the contract's own words. */
const FALLBACK_LEVELS: Record<AtlasEffort, { label: string; blurb: string }> = {
  low: { label: "Low", blurb: "Quick answer from a few lookups." },
  medium: { label: "Medium", blurb: "Balanced. Checks the main sources." },
  high: { label: "High", blurb: "Thorough. Follows more leads." },
  max: { label: "Max", blurb: "Slowest. Thinks hardest and reads widest." },
};

/** How close to the end still counts as "at the end" for following. */
const FOLLOW_SLACK_PX = 80;

const EMPTY_VOTES: Record<number, "up" | "down"> = {};

export function OrgAgentThread({
  askId,
  size,
  topInset,
  autoFocus,
}: {
  askId: string;
  /** `compact` in the side panel and the messenger, `page` full page. */
  size: "compact" | "page";
  /** A header floating over the top (any CSS length): the content starts
   *  below it and its blur band, and scrolls up under both. */
  topInset?: string;
  autoFocus?: boolean;
}) {
  const log = useOrgAgentStore((s) => s.logs[askId]);
  const summary = useOrgAgentStore((s) => s.asks[askId]);
  const outbox = useOrgAgentStore.use.outbox();
  const loading = useOrgAgentStore((s) => s.loading.includes(askId));
  const loadError = useOrgAgentStore((s) => s.loadErrors[askId]);
  const votes = useOrgAgentStore((s) => s.votes[askId] ?? EMPTY_VOTES);
  const { send, openAsk, stop } = useOrgAgentStore.use.actions();
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const page = size === "page";
  const measure = page ? "mx-auto w-full max-w-[760px] px-6" : "px-4";
  const temp = isTempAsk(askId);

  // Read the conversation the first time it is shown here.
  useEffect(() => {
    if (!temp && !log) void openAsk(askId);
  }, [askId, temp, log, openAsk]);

  const view = useMemo(() => foldAsk(log?.events ?? []), [log?.events]);
  const handles = useMemo(() => handleIndex(view.cards), [view.cards]);
  const pending = useMemo(() => pendingFor(outbox, askId), [outbox, askId]);
  const status = log?.ask.status ?? summary?.status ?? "idle";
  const running = useOrgAgentStore((s) => askBusy(s, askId) || askWaiting(s, askId));
  const lastTurn = lastOf(view.turns);
  const onOpen = useCallback((target: OrgAgentTarget) => openTarget(target), []);

  // Follow the end while the reader is there; leave them be once they have
  // scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [log?.events.length, pending.length, status]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
  };

  const empty = view.turns.length === 0 && pending.length === 0;
  const onSend = (text: string, mentions: ReturnType<OrgAgentInputHandle["getMentions"]>) => {
    const s = useOrgAgentStore.getState();
    atEnd.current = true;
    send(askId, text, { mentions, effort: s.effort, deepResearch: s.deepResearch });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="hide-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto"
        // Past the header and its blur band, or the first message sits under
        // the bar, permanently blurred.
        style={topInset ? { paddingTop: `calc(${topInset} + ${page ? 34 : 8}px)` } : undefined}
      >
        {empty ? (
          temp ? (
            <Welcome onPick={(q) => onSend(q, [])} />
          ) : loadError ? (
            <div className={cn(measure, "py-6")}>
              <Notice tone="error">
                <span className="min-w-0 flex-1">{loadError}</span>
                <Button size="xs" variant="outline" onClick={() => void openAsk(askId)}>
                  Try again
                </Button>
              </Notice>
            </div>
          ) : (
            <ThreadSkeleton measure={measure} busy={loading || !log} />
          )
        ) : (
          <div className={cn(measure, "flex flex-col gap-7", page ? "py-8" : "py-5")}>
            {view.compactedThrough !== null && (
              <p className="text-center text-2xs text-muted-foreground">
                Earlier messages were summarised for Atlas; they are all still here.
              </p>
            )}
            {view.turns.map((turn) => (
              <TurnView
                key={turn.key}
                askId={askId}
                turn={turn}
                status={status}
                live={turn === lastTurn}
                last={turn === lastTurn && pending.length === 0}
                handles={handles}
                vote={turn.doneSeq !== null ? (votes[turn.doneSeq] ?? null) : null}
                onOpen={onOpen}
              />
            ))}
            {pending.map((p) => (
              <PendingTurn key={p.clientMsgId} pending={p} />
            ))}
          </div>
        )}
      </div>
      <div
        className={cn("shrink-0", page ? "mx-auto w-full max-w-[760px] px-6 pb-5" : "px-3 pb-3")}
      >
        <ConnectionLine />
        <Composer
          compact={!page}
          working={running}
          canStop={!temp && status !== "idle"}
          onStop={() => stop(askId)}
          autoFocus={autoFocus}
          onSend={onSend}
        />
      </div>
    </div>
  );
}

function ThreadSkeleton({ measure, busy }: { measure: string; busy: boolean }) {
  return (
    <div
      className={cn(measure, "flex flex-col gap-4 py-8", busy && "animate-pulse")}
      aria-busy={busy}
    >
      <div className="ml-auto h-9 w-1/2 rounded-xl bg-element-hover" />
      <div className="h-3 w-2/3 rounded bg-element-hover" />
      <div className="h-3 w-5/6 rounded bg-element-hover" />
      <div className="h-3 w-1/2 rounded bg-element-hover" />
    </div>
  );
}

/** Why the agent cannot answer right now, when it cannot. */
function ConnectionLine() {
  const connection = useOrgAgentStore.use.connection();
  const atlas = useOrgAgentStore.use.atlas();
  const error = useOrgAgentStore.use.error();
  const { clearError } = useOrgAgentStore.use.actions();
  const signedIn = useAuthStore((s) => s.snapshot.status === "signed-in");

  let line: React.ReactNode = null;
  if (!signedIn)
    line = <Notice tone="info">Sign in to Atlas to ask about your team's work.</Notice>;
  else if (connection === "disconnected")
    line = <Notice tone="info">Choose an organisation to ask Atlas about its work.</Notice>;
  else if (atlas && !atlas.enabled)
    line = <Notice tone="warning">Atlas is turned off for this organisation.</Notice>;
  else if (connection === "unavailable")
    line = (
      <Notice tone="warning">
        <span className="min-w-0 flex-1">Atlas is not available to you in this organisation.</span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void import("../lib/org-agent-api").then((m) => m.orgAgent.reconnect())}
        >
          Try again
        </Button>
      </Notice>
    );
  else if (connection === "connecting" || connection === "backoff")
    line = <p className="px-1 pb-2 text-2xs text-muted-foreground">Connecting to Atlas…</p>;
  else if (error)
    line = (
      <Notice tone="error">
        <span className="min-w-0 flex-1">{error.message}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={clearError}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <X size={12} />
        </button>
      </Notice>
    );
  if (!line) return null;
  return <div className="pb-2">{line}</div>;
}

// ── The empty conversation ──────────────────────────────────────────────────

function Welcome({ onPick }: { onPick: (question: string) => void }) {
  const snapshot = useAuthStore.use.snapshot();
  const firstName =
    snapshot.status === "signed-in" ? snapshot.user?.name.trim().split(/\s+/)[0] : undefined;
  const greeting = firstName ? `Hi, ${firstName} 👋` : "Welcome back 👋";
  const ready = useOrgAgentStore((s) => s.connection === "open");

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
              disabled={!ready}
              onClick={() => onPick(text)}
              className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-2.5 text-left transition-all duration-150 hover:border-border-strong hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
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

// ── Composer ────────────────────────────────────────────────────────────────

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
 * The coding agent's composer, built from its parts: the same input card — a
 * capsule while empty and away, a card in use — the same send button, and the
 * same tray folding away under it. The tray is the agent's: mention, the
 * effort level, Deep research, and today's count. While the agent works, a
 * beam rides the card's edge and the send button becomes Stop.
 */
function Composer({
  compact,
  working,
  canStop,
  onStop,
  autoFocus,
  onSend,
}: {
  compact: boolean;
  working: boolean;
  canStop: boolean;
  onStop: () => void;
  autoFocus?: boolean;
  onSend: (text: string, mentions: ReturnType<OrgAgentInputHandle["getMentions"]>) => void;
}) {
  const input = useRef<OrgAgentInputHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);
  const [focused, setFocused] = useState(false);
  const appearance = useAppearance();
  const collapsed = empty && !focused;
  const trayShown = useComposerFold(collapsed, card, tray);
  const enterToSend = useSettingsStore((s) => s.settings.enterToSend);
  const orgId = useOrgAgentStore.use.orgId();
  const connected = useOrgAgentStore((s) => s.connection === "open");
  const deepResearch = useOrgAgentStore.use.deepResearch();

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const text = input.current?.getValue().trim() ?? "";
    if (!text || !connected) return;
    onSend(text, input.current?.getMentions() ?? []);
    input.current?.clear();
  };

  const menuOpen = () =>
    !!root.current?.querySelector("[data-popup-open], [aria-expanded='true']") ||
    !!document.querySelector("[data-slot='org-agent-mention-picker']");
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

  const stopping = working && canStop && empty;
  const sendLabel = deepResearch ? "Start research" : "Send";

  return (
    <div
      ref={root}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={onBlur}
      onPointerDownCapture={() => setFocused(true)}
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
              <OrgAgentInput
                ref={input}
                orgId={orgId}
                placeholder={
                  deepResearch ? "What should Atlas research?" : "Ask Atlas about your team's work…"
                }
                enterToSend={enterToSend}
                onSubmit={submit}
                onEmptyChange={setEmpty}
              />
            </div>
            <Hint side="top" wrap={false} label={stopping ? "Stop" : sendLabel}>
              <button
                type="button"
                onClick={stopping ? onStop : submit}
                disabled={!stopping && (empty || !connected)}
                aria-label={stopping ? "Stop" : sendLabel}
                className={cn(
                  "absolute top-[8px] right-[8px] flex h-[28px] w-[28px] items-center justify-center rounded-lg border transition-colors",
                  !stopping && (empty || !connected)
                    ? "cursor-not-allowed border-transparent text-[var(--muted-foreground)]"
                    : "cursor-pointer border-transparent text-[var(--foreground)] hover:border-[var(--border)] hover:bg-[var(--atlas-element-hover)]",
                )}
              >
                {stopping ? (
                  <Square size={11} fill="currentColor" />
                ) : deepResearch ? (
                  <Telescope size={14} />
                ) : (
                  <ArrowUp size={15} strokeWidth={2.5} />
                )}
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

/** The tray: mention, the level and Deep research on the left; today's
 *  count on the right. */
function Tray({ compact, onMention }: { compact: boolean; onMention: () => void }) {
  const effort = useOrgAgentStore.use.effort();
  const deepResearch = useOrgAgentStore.use.deepResearch();
  const info = useOrgAgentStore.use.effortInfo();
  const atlas = useOrgAgentStore.use.atlas();
  const { setEffort, setDeepResearch, refreshEffort } = useOrgAgentStore.use.actions();
  const [open, setOpen] = useState(false);

  // The picker's data, read when the composer opens.
  useEffect(() => {
    void refreshEffort();
  }, [refreshEffort]);

  const levels = ATLAS_EFFORTS.map((e) => {
    const server = info?.levels.find((l) => l.effort === e);
    return {
      value: e,
      label: server?.label ?? FALLBACK_LEVELS[e].label,
      blurb: server?.blurb ?? FALLBACK_LEVELS[e].blurb,
      eta: server ? durationWords(server.eta_seconds) : null,
    };
  });
  const current = levels.find((l) => l.value === effort) ?? levels[1]!;
  const dr = info?.deep_research;
  const deepLeft = dr ? dr.remaining : null;
  const deepAllowed = dr ? dr.allowed && dr.remaining > 0 : true;
  const deepReason = !dr
    ? "Deep research"
    : !dr.allowed
      ? "Deep research is not available in this organisation"
      : dr.remaining === 0
        ? "You have used today's Deep research. It resets at midnight UTC."
        : `Deep research: ${dr.remaining} of ${dr.per_day} left today · ${durationWords(dr.eta_seconds)}`;

  const deepPill = (
    <HintItem label={deepReason}>
      <button
        type="button"
        aria-pressed={deepResearch}
        disabled={!deepAllowed && !deepResearch}
        onClick={() => setDeepResearch(!deepResearch)}
        className={pill(deepResearch)}
      >
        <Telescope size={11} />
        Deep Research
        {deepLeft !== null && (
          <span className="tabular-nums text-[var(--muted-foreground)]">{deepLeft}</span>
        )}
      </button>
    </HintItem>
  );

  return (
    <HintGroup side="top">
      <div className="flex min-w-0 items-center gap-1">
        <HintItem label="Mention a person, conversation, session or project">
          <button
            type="button"
            aria-label="Mention"
            onClick={onMention}
            className={cn(pill(false), "w-6.5 justify-center px-0")}
          >
            <AtSign size={12} />
          </button>
        </HintItem>
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            disabled={deepResearch}
            render={
              <button type="button" className={pill(false)} aria-label={`Effort: ${current.label}`}>
                <Gauge size={11} />
                {current.label}
                <ChevronDown size={10} />
              </button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner className="z-popover" side="top" align="start" sideOffset={6}>
              <Popover.Popup className="w-[260px] origin-[var(--transform-origin)] overflow-hidden rounded-xl border border-border bg-background p-1 text-foreground shadow-lg data-closed:animate-scale-out data-open:animate-scale-in">
                {levels.map((e) => (
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
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-sm text-foreground">{e.label}</span>
                        {e.eta && (
                          <span className="text-2xs tabular-nums text-muted-foreground">
                            {e.eta}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground">{e.blurb}</span>
                    </span>
                  </button>
                ))}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        {!compact && deepPill}
      </div>
      {compact
        ? deepPill
        : atlas && (
            <span className="shrink-0 text-2xs tabular-nums text-[var(--muted-foreground)]">
              {atlas.limits.turns_today} of {atlas.limits.turns_per_day} today
            </span>
          )}
    </HintGroup>
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
