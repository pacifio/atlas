import {
  lazy,
  Suspense,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { clearAgentQuestion } from "@/features/notifications/lib/agent-notifier";
import { useChatStore } from "../stores/chat-store";
import { pinScope, resolvePinIndex, type ChatPin } from "../stores/chat-pins-store";
import { useDetailPanelStore } from "../stores/detail-panel-store";
import { sessionScope } from "../lib/session-scope";
import {
  selectDockedOpen,
  useSessionDetailsStore,
} from "@/features/session-context/stores/session-details-store";
import { useSessionHeaderSlot } from "../stores/session-header-slot-store";
import { useSessionSidePanel, useSessionSidePanelStore } from "../stores/session-side-panel-store";
import { useSendHeldForTerminal } from "../stores/live-elsewhere-store";
import { driverLabel } from "../lib/rc-api";
import { useRcRemoteDriver } from "../stores/rc-store";
import type { ImageAttachment } from "@/types/agents";
import { hasInFlightToolCalls, isBusyAgentStatus, pluginIdForAgent } from "@/types/agent";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import type { MentionData } from "../lib/mentions";
import { usePaneFind } from "../lib/use-pane-find";
import { SessionHeaderControls } from "./session-header";
import { adoptSessionDrawer } from "@/features/terminal/lib/session-drawer";
import { SessionDockLane } from "./session-dock-lane";
import { projectPathForTab } from "../lib/tab-project";
import { MemoryUpdatedCard } from "@/features/memory/components/memory-updated-card";
import { OPEN_TURN_DIFF_EVENT, type TurnDiffRequest } from "../lib/open-turn-diff";
import { showTurnDiff } from "../lib/show-turn-diff";
import { PermissionModal } from "./permission-modal";
import { ChatCommentsController } from "./chat-comments-controller";
import { grantLocksComposer, useNoAiGrant } from "../stores/ai-grant-store";
import { SessionElicitation } from "./session-elicitation";
import { ChatComposer } from "./chat-composer";
import { WelcomeGlow } from "./welcome-glow";
import { usePaneTopInset } from "@/features/layout/lib/pane-top-inset";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useContextDock } from "@/features/session-context/lib/use-context-dock";
import { createChatPanelHandlers } from "../lib/chat-panel-handlers";
import { useAgentBind, type BindControl } from "../hooks/use-agent-bind";
import { useSessionBackfill } from "../hooks/use-session-backfill";
import { useChatPanelHotkeys } from "../hooks/use-chat-panel-hotkeys";
import { useAcpPrewarm } from "../hooks/use-acp-prewarm";
import { useChatPanelEvents, useQueueDrain, type ChatSendHandler } from "../hooks/use-queue-drain";
import { ChatPanelLayout } from "./views/chat-panel-layout";
import { ChatPanelSkeleton, LoadingTranscriptState } from "./views/transcript-loading";
import { JumpToBottomPill } from "./views/jump-to-bottom-pill";
import { WelcomeStateView } from "./views/welcome-state-view";

/** When this app run first saw each bound session (ms). The "Memory updated"
 *  card lists only what the session wrote since then, so a session resumed
 *  after a restart does not re-list what it wrote days ago. Module-level so a
 *  panel re-mount keeps it; the chat store records no session start. */
const memorySinceBySession = new Map<string, number>();
function memorySince(sessionId: string): number {
  let at = memorySinceBySession.get(sessionId);
  if (at === undefined) {
    at = Date.now();
    memorySinceBySession.set(sessionId, at);
  }
  return at;
}

// Both panels are modal-style and never visible on first paint. Lazy so
// they don't add to the initial chunk.
const BashHistoryPanel = lazy(() =>
  import("./bash-history-panel").then((m) => ({ default: m.BashHistoryPanel })),
);
const PlansPanel = lazy(() => import("./plans-panel").then((m) => ({ default: m.PlansPanel })));
const ChatSearchPalette = lazy(() =>
  import("./views/chat-search-palette").then((m) => ({
    default: m.ChatSearchPalette,
  })),
);

// The transcript transitively imports the markdown vendor chunk
// (`remark-gfm` + `rehype-highlight`, ~330 KB raw / 101 KB gzip). Lazy so an
// empty-chat first paint doesn't preload it; loads the first time this tab has
// messages.
const Transcript = lazy(() => import("./transcript").then((m) => ({ default: m.Transcript })));
import type { TranscriptHandle } from "./transcript";
// Diffs + tool output live here rather than inline in the thread — see the
// module header for why that's a perf decision as much as a UX one.
const DetailPanel = lazy(() => import("./detail-panel").then((m) => ({ default: m.DetailPanel })));

interface ChatPanelProps {
  tabId: string;
}

// `memo`: the panel's only prop is a stable `tabId`, and every mounted chat
// stays mounted behind whichever tab is showing. Without this, each tab switch
// re-rendered EVERY mounted chat (the center panel re-renders on the layout
// store's active-tab write and re-emits these elements), and each of those
// walked its whole transcript's row list. Streaming re-renders still arrive
// through this panel's own store subscription.
export const ChatPanel = memo(function ChatPanel({ tabId }: ChatPanelProps) {
  // Subscribe to ONLY this tab's session. Streaming chunks on other tabs
  // shouldn't repaint this panel — immer preserves reference equality for
  // unchanged sub-paths, so `s.sessions[tabId]` only changes when this tab
  // mutates.
  const session = useChatStore((s) => s.sessions[tabId]);
  const { createSession, addMessage, updateSessionStatus, setSessionTitle, clearElicitation } =
    useChatStore.use.actions();
  // Narrow subscription — an unanswered `elicitation/create` (P3.3).
  const pendingElicitation = useChatStore((s) => s.sessions[tabId]?.pendingElicitation);
  // Answering a question is steering: while someone else drives from remote
  // control the card says so instead of sending (Rust refuses it anyway).
  const elicitationSeat = useRcRemoteDriver(useChatStore((s) => s.sessions[tabId]?.acpSessionId));
  const elicitationRemoteDriver = elicitationSeat ? driverLabel(elicitationSeat) : null;

  // Opened from the Details card's Activity section, so kept by tab in a
  // store rather than here (`session-side-panel-store.ts`).
  const sidePanel = useSessionSidePanel(tabId);
  const { close: closeSidePanel } = useSessionSidePanelStore.use.actions();
  // Narrow boolean — changes only when the detail panel opens or closes.
  const detailOpen = useDetailPanelStore((s) => !!s.targets[tabId]);
  // The session's scope, the key of its Details card and terminal drawer.
  // This panel reads no Details state at all: the title-bar button, the dock
  // lane and the dock-open flag subscribe for themselves, so a toggle
  // re-renders them and never this panel or the transcript. Keyed by the
  // SESSION, not the tab: "new
  // agent" and history both reuse this tab, and a tab-keyed card followed the
  // user into every session it showed.
  const scope = sessionScope(tabId, session?.acpSessionId);
  const { adopt: adoptDetails } = useSessionDetailsStore.use.actions();
  // The title-bar slot this session's controls portal into, while its column
  // shows it (`session-header-slot-store.ts`).
  const headerSlot = useSessionHeaderSlot(tabId);
  // A card opened on a queued first send, before the session bound, belongs
  // to the session that bind produced — and must not be left on the tab
  // scope, where the tab's next session would inherit it.
  useEffect(() => {
    if (!session?.acpSessionId) return;
    adoptDetails(sessionScope(tabId, undefined), scope);
    // The terminal drawer too (unmounted until the terminal rework, so this
    // moves nothing today): shells opened before the first message are the
    // session's, and stay open and running across the bind.
    adoptSessionDrawer(sessionScope(tabId, undefined), scope);
  }, [adoptDetails, tabId, session?.acpSessionId, scope]);

  // A turn's diff, in the review panel beside the session. Driven by a window
  // event rather than a prop chain so a row opening it re-renders nothing in
  // the transcript. Every mounted chat hears it; only the one holding the turn
  // finds edits for it, so only that one opens anything.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<TurnDiffRequest>).detail;
      if (detail?.turnId) showTurnDiff(tabId, detail);
    };
    window.addEventListener(OPEN_TURN_DIFF_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TURN_DIFF_EVENT, onOpen);
  }, [tabId]);

  // Warm the review panel's chunk while the reader is idle, so opening a
  // turn's diff is a paint rather than a fetch. Not its workers: they start
  // with the first viewer, and a pool per idle chat would be threads nobody
  // asked for.
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
    };
    const load = () => {
      void import("@/features/git/components/diff-viewer/review-panel");
    };
    // Short timeout: this competes with nothing the reader can see, and waiting
    // four seconds meant an early click still paid full price.
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(load, { timeout: 1200 });
    } else {
      const t = window.setTimeout(load, 800);
      return () => window.clearTimeout(t);
    }
  }, []);
  // Cmd+F find — scoped to this pane + tab (see usePaneFind).
  const [searchPaletteOpen, setSearchPaletteOpen] = usePaneFind(tabId);
  const rootRef = useRef<HTMLDivElement>(null);
  // The Details card docks at this column's top-right when the panel is wide
  // enough (`use-context-dock.ts`). The room it needs is kept only while the
  // docked card is OPEN: closed, the transcript and composer centre in the
  // whole panel instead of leaving an empty lane on the right; opening the
  // card slides them over to clear it. The room is CSS variables set from
  // the panel's width, applied by `group-data-[dock-open]/dock` classes, and
  // the flag is set by `DockOpenFlag` — so a toggle re-renders that and
  // nothing else, never this panel or the transcript. Off on an empty
  // session, which has no column to clear: the card is its button's popover.
  const conversationRef = useRef<HTMLDivElement>(null);
  const contextDock = useContextDock(conversationRef, (session?.messages.length ?? 0) > 0);
  // The transcript's box, under the title bar and down to the composer: the
  // Details popover is capped at its height.
  const stageRef = useRef<HTMLDivElement>(null);

  // Scroll-to-bottom state is owned here so the floating button can live
  // next to the Claude-setup pill above the input (instead of inside
  // the transcript). Transcript publishes the "scrolled up" bit via
  // `onShowJumpChange` and exposes `scrollToBottom` via its ref.
  const messagesListRef = useRef<TranscriptHandle>(null);
  // The window bar floats over this panel; the transcript scrolls under it.
  const topInset = usePaneTopInset();
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [jumpCount, setJumpCount] = useState(0);
  // Stable so the transcript's `[showJump, newCount, onShowJumpChange]`
  // effect doesn't re-fire on every ChatPanel render (i.e. every stream chunk).
  const onShowJumpChange = useCallback((visible: boolean, count?: number) => {
    setShowJumpToBottom(visible);
    setJumpCount(count ?? 0);
  }, []);

  const acpSessionId = session?.acpSessionId ?? "";
  const memoryWritesSince = acpSessionId ? memorySince(acpSessionId) : 0;
  /** Handle on the bind effect's in-flight attempt — see `epoch` inside it.
   *  Null whenever no bind effect is mounted (tab already bound). */
  const bindControlRef = useRef<BindControl | null>(null);
  /** Bumped on every Restart so the working indicator's clock starts over. */
  const [bindEpoch, setBindEpoch] = useState(0);
  // The manager's install/launch progress for this tab's agent, when it sends
  // any ("Downloading Node.js…"); replaces the generic "Starting {agent}".
  const startingPluginId = pluginIdForAgent(session?.agentType);
  const startingStatus = useChatStore((s) => s.agentStartingStatus[startingPluginId]);
  // One scope for the whole panel — the header's pin dropdown and the
  // transcript's per-row pin buttons must address the same bucket.
  const pinScopeKey = pinScope(tabId, session?.acpSessionId);

  // A fresh chat starts on the native agent and starts immediately: the
  // default needs no probe, so there is no window in which the tab has to sit
  // session-less waiting to find out which agent it is.
  useEffect(() => {
    if (!session) createSession(tabId);
  }, [tabId, session, createSession]);

  // Eager bind on mount (and on agent switch), the backfill for sessions
  // bound before this mount, the panel's chords, and the once-per-app
  // pre-warm of agents the user has used — in that effect order.
  useAgentBind(tabId, session, bindControlRef);
  useSessionBackfill(tabId, session);
  useChatPanelHotkeys(tabId, rootRef);
  useAcpPrewarm();

  // A session another process is writing (ADR-0001 amendment, Rule 7) closes
  // the drain gate like a pending resume does; "Send anyway" or the other
  // process going quiet is its falling edge. The composer feeds the live set.
  const heldElsewhere = useSendHeldForTerminal(session?.acpSessionId);
  // The no-AI-grant hold on the queue (`drain-gate.ts`): what the composer
  // lock would be with no turn running.
  const noAiGrant = useNoAiGrant();
  const grantHold = grantLocksComposer(noAiGrant, session?.agentType ?? "", false);
  const handleSendRef = useRef<ChatSendHandler | null>(null);
  const handleStopRef = useRef<(() => void) | null>(null);
  const releaseQueueRef = useRef<(() => Promise<void>) | null>(null);
  // STABLE wrappers passed to the memoized <ChatComposer> so it doesn't
  // re-render on every ChatPanel render (i.e. every streaming chunk). The real
  // handlers are reassigned to the refs each render, so the wrappers always call
  // the latest logic while keeping a constant identity. This is the H1 fix:
  // ChatPanel still re-renders per chunk, but its heavy composer subtree bails.
  // Forwards every argument, not a listed few: naming `(content, mentions)`
  // here once dropped the composer's staged images, and `tsc` cannot see it —
  // a callback with fewer parameters is assignable to one with more.
  //
  // A trivial one-line slip that took a full trace to find (d8cda90c): every
  // pasted image vanished on Enter for months, and the hunt went through Rust,
  // the ACP connection and the Claude adapter before it ended here. If images
  // go missing again, check this wrapper first.
  const onSendStable = useCallback(
    (content: string, mentions: MentionData[], attachments?: ImageAttachment[]) =>
      handleSendRef.current?.(content, mentions, attachments),
    [],
  );
  const onStopStable = useCallback(() => handleStopRef.current?.(), []);
  const onScrollToBottomStable = useCallback(() => messagesListRef.current?.scrollToBottom(), []);
  // Same stable-identity discipline for the OTHER memo'd siblings that render
  // once per streaming frame with ChatPanel: fresh inline closures here would
  // defeat their memo() exactly like they would the composer's.
  const onPermissionSend = useCallback((t: string) => handleSendRef.current?.(t, []), []);
  // Same shape as the bash panel's jump: the index is resolved against the
  // session's messages, which the transcript projects as they are (see
  // `scrollToMessage`).
  const onJumpToPinStable = useCallback(
    (pin: ChatPin) => {
      const messages = useChatStore.getState().sessions[tabId]?.messages ?? [];
      const index = resolvePinIndex(messages, pin);
      if (index < 0) {
        // Enough to tell "the thread is empty" from "the id was re-minted and
        // the text drifted" from the console alone, without logging content.
        console.warn("chat pins: pin did not resolve", {
          tabId,
          messages: messages.length,
          idPresent: messages.some((m) => m.id === pin.messageId),
          userMessages: messages.filter((m) => m.role === "user").length,
          textLen: pin.text.length,
        });
        toast.error("That message is no longer in this thread");
        return;
      }
      window.dispatchEvent(new CustomEvent("atlas:chat-jump", { detail: { index, tabId } }));
    },
    [tabId],
  );
  // The drain edge and the Rust queue hold, then the window events that send
  // or stop from outside the composer.
  useQueueDrain({ tabId, session, heldElsewhere, grantHold, handleSendRef, releaseQueueRef });
  useChatPanelEvents(tabId, handleSendRef, handleStopRef);

  // No session yet. Normally a single frame (the effect above creates it on
  // mount); on a first-ever launch it also covers the brief wait for the Claude
  // Code probe that decides which agent this chat starts on. Show the transcript
  // skeleton rather than a blank pane so that wait doesn't read as a broken tab.
  if (!session) {
    return <ChatPanelSkeleton rootRef={rootRef} />;
  }

  const {
    handleRestartAgent,
    handleSwitchAgent,
    handleCopyDiagnostics,
    handleStop,
    handleSend,
    releaseQueue,
  } = createChatPanelHandlers({
    tabId,
    session,
    grantHold,
    bindControlRef,
    setBindEpoch,
    addMessage,
    updateSessionStatus,
    setSessionTitle,
  });

  // Keep the queue-drain effect pointing at the latest handleSend closure.
  handleSendRef.current = handleSend;
  handleStopRef.current = handleStop;
  releaseQueueRef.current = releaseQueue;

  return (
    <ChatPanelLayout
      rootRef={rootRef}
      conversationRef={conversationRef}
      stageRef={stageRef}
      dock={contextDock.docked ? { inset: contextDock.inset, reserve: contextDock.reserve } : null}
      columnHead={
        <>
          <DockOpenFlag
            targetRef={conversationRef}
            scope={scope}
            docked={contextDock.docked && session.messages.length > 0}
          />
          {/* The session's controls live in the window's title bar, beside the
              breadcrumb that names it; there is no header row in here, so the
              transcript starts right under the bar. */}
          {headerSlot &&
            createPortal(
              <SessionHeaderControls
                tabId={tabId}
                scope={scope}
                docked={contextDock.docked}
                stageRef={stageRef}
                pinScopeKey={pinScopeKey}
                onJumpToPin={onJumpToPinStable}
              />,
              headerSlot,
            )}
        </>
      }
      isEmpty={session.messages.length === 0}
      emptyStage={session.transcriptLoading ? <LoadingTranscriptState /> : <WelcomeState />}
      transcript={
        <Suspense fallback={<LoadingTranscriptState />}>
          <Transcript
            ref={messagesListRef}
            tabId={tabId}
            acpSessionId={acpSessionId}
            messages={session.messages}
            isStreaming={session.status === "running"}
            turnInProgress={isBusyAgentStatus(session.status)}
            agentType={session.agentType}
            onShowJumpChange={onShowJumpChange}
            topInset={topInset}
            workingLabel={
              session.pendingSend
                ? (startingStatus ?? `Starting ${agentMeta(session.agentType).label}`)
                : undefined
            }
            workingEpoch={bindEpoch}
            onStallRestart={handleRestartAgent}
            onStallSwitch={handleSwitchAgent}
            onStallCopyDiagnostics={handleCopyDiagnostics}
            footer={
              <MemoryUpdatedCard
                projectPath={projectPathForTab(tabId)}
                sessionId={acpSessionId || null}
                since={memoryWritesSince}
              />
            }
          />
        </Suspense>
      }
      dockLane={<SessionDockLane tabId={tabId} scope={scope} docked={contextDock.docked} />}
      composerStack={
        <>
          {/* Anchored to this whole stack, not to the composer: the card below
              sits directly on top of the composer, so a pill anchored there
              floated over the card's own buttons and answer field. */}
          {showJumpToBottom && (
            <JumpToBottomPill count={jumpCount} onClick={onScrollToBottomStable} />
          )}
          {/* Permission / question prompt — an inline card pinned above the
              composer (plan reviews still render as a centered modal). */}
          <PermissionModal tabId={tabId} onSendMessage={onPermissionSend} />
          {/* Mounted whether or not a question is pending: the drawer inside
              owns the enter AND exit animation, and a component the parent
              unmounts cannot animate anything out. */}
          <SessionElicitation
            pending={pendingElicitation ?? null}
            remoteDriver={elicitationRemoteDriver}
            onClose={() => {
              if (!pendingElicitation) return;
              clearAgentQuestion(tabId, pendingElicitation.requestId);
              clearElicitation(tabId);
            }}
          />
          {/* Bottom fade lives in the transcript; the centered floating
              row (setup pill + scroll-to-bottom) lives inside
              ChatComposer below. */}
          <ChatComposer
            tabId={tabId}
            onSend={onSendStable}
            onStop={onStopStable}
            running={isBusyAgentStatus(session.status) || hasInFlightToolCalls(session)}
            stopping={!!session.stopping}
          />
        </>
      }
    >
      {sidePanel === "bash" && (
        <Suspense fallback={null}>
          <BashHistoryPanel
            messages={session.messages}
            onJump={(idx) => {
              window.dispatchEvent(
                new CustomEvent("atlas:chat-jump", { detail: { index: idx, tabId } }),
              );
            }}
            onClose={() => closeSidePanel(tabId)}
          />
        </Suspense>
      )}

      {sidePanel === "plans" && (
        <Suspense fallback={null}>
          <PlansPanel onClose={() => closeSidePanel(tabId)} />
        </Suspense>
      )}

      {/* Cloud comments: the resolver runs for the pane's lifetime. It is
          what tells the Details card's Session section whether this session is synced,
          and what feeds comments to the transcript rows and the comments popup. */}
      <ChatCommentsController tabId={tabId} />

      {/* Diff / tool-output detail. Gated on a narrow boolean selector so the
          chunk isn't fetched until the reader first opens it, and so this
          subscription only fires on open/close — never on a streaming chunk.
          The panel's own store owns the target, so toggling it re-renders zero
          transcript rows. */}
      {detailOpen && (
        <Suspense fallback={null}>
          <DetailPanel tabId={tabId} messages={session.messages} />
        </Suspense>
      )}

      {searchPaletteOpen && (
        <Suspense fallback={null}>
          <ChatSearchPalette
            open={searchPaletteOpen}
            onOpenChange={setSearchPaletteOpen}
            messages={session.messages}
            onJump={(idx) =>
              window.dispatchEvent(
                new CustomEvent("atlas:chat-jump", { detail: { index: idx, tabId } }),
              )
            }
          />
        </Suspense>
      )}
    </ChatPanelLayout>
  );
});

/** The empty session's greeting, from the signed-in user's first name. Its own
 *  component so the auth subscription re-renders this and not the panel. */
function WelcomeState() {
  const snapshot = useAuthStore.use.snapshot();
  const firstName =
    snapshot.status === "signed-in" ? snapshot.user?.name.trim().split(/\s+/)[0] : undefined;
  const greeting = firstName ? `Hi, ${firstName} 👋` : "Welcome back 👋";
  return (
    <WelcomeStateView
      greeting={greeting}
      backdrop={<WelcomeGlow />}
      onPick={(text) =>
        window.dispatchEvent(new CustomEvent("atlas:chat-prefill", { detail: { text } }))
      }
    />
  );
}

/** Marks the chat panel `data-dock-open` while its docked Details card is
 *  open, which applies the room the panel keeps for the card. A component of
 *  its own, writing one attribute, so a toggle re-renders it and nothing
 *  else. */
function DockOpenFlag({
  targetRef,
  scope,
  docked,
}: {
  targetRef: React.RefObject<HTMLElement | null>;
  scope: string;
  docked: boolean;
}) {
  const open = useSessionDetailsStore((s) => docked && selectDockedOpen(s, scope));
  useLayoutEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    if (open) el.setAttribute("data-dock-open", "");
    else el.removeAttribute("data-dock-open");
  }, [targetRef, open]);
  return null;
}
