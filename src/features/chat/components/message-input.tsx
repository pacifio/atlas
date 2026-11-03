import { useTipsStore } from "@/features/tips/stores/tips-store";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";
import { CONTENT_COLUMN } from "../lib/row-metrics";
import { useChatStore } from "../stores/chat-store";
import { useNativeModelsOrgRefresh } from "../stores/native-models-store";
import { removeQueuedPrompt, enqueuePrompt } from "../lib/turn-queue";
import { type SwitchableAgent } from "@/types/agent";
import {
  agentMeta,
  catalogEntry as agentCatalogEntry,
  switchableAgentOf,
} from "@/features/agents/lib/agent-meta";
import { forkSessionToNewTab } from "../lib/fork-session";
import { switchAgentForTab } from "@/features/chat/lib/switch-agent";
// The editor (`ChatInput`) and both pickers load as their own chunks
// (`use-lazy-composer-chunks.ts`); only their types are imported here.
import type { ChatInputHandle, MentionTrigger, SlashTrigger } from "./chat-input";
import type { MentionPickerHandle } from "@/features/mentions/components/mention-picker";
import type { SlashCommandPickerHandle, SlashCommand } from "./slash-command-picker";
import { useAiGrantBarShown } from "./ai-grant-bar";
import { useRcRemoteDriver } from "../stores/rc-store";
import { useSendHeldForTerminal } from "../stores/live-elsewhere-store";
import { SessionProjectsContext } from "../hooks/use-session-projects";
import { useLiveElsewhereFeed } from "../hooks/use-live-elsewhere-feed";
import { grantLocksComposer, useAiGrantProbe, useNoAiGrant } from "../stores/ai-grant-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { ImageAttachment } from "@/types/agents";
import { useComposerFileDrop } from "../hooks/use-composer-file-drop";
import { useAppStore } from "@/features/app/stores/app-store";
// Value imports from the composer stay editor-free: anything that imports
// Tiptap at module scope would pull it into this eager module's graph and
// defeat the dynamic `import("./chat-input")` boundary.
import { useComposerDraft } from "@/components/composer/use-composer-draft";
import type { MentionData } from "../lib/mentions";
import { collapsePastes } from "../lib/pasted-text";
import { collapseCites } from "../lib/cited-text";
import { forgetSentTexts, rememberMention } from "../lib/mention-registry";
import { buildAgentSlashCommands } from "../lib/agent-slash-commands";
import { createValueStore } from "../lib/value-store";
import { useComposerModesSelfHeal } from "../hooks/use-composer-modes-self-heal";
import { useNativeEffortSeed } from "../hooks/use-native-effort-seed";
import { useLazyComposerChunks } from "../hooks/use-lazy-composer-chunks";
import { useComposerAuthReason } from "../hooks/use-composer-auth-reason";
import { useComposerImages } from "../hooks/use-composer-images";
import { useComposerAttachments } from "../hooks/use-composer-attachments";
import { useComposerFocus } from "../hooks/use-composer-focus";
import { useComposerPickers } from "../hooks/use-composer-pickers";
import { useComposerEvents } from "../hooks/use-composer-events";
import { SlashPickerHost } from "./slash-picker-host";
import { ComposerNotices } from "./composer-notices";
import { ComposerTray } from "./composer-tray";
import { ComposerQueue } from "./views/composer-queue";
import { ComposerInputCard } from "./views/composer-input-card";
import { ComposerDropOverlay, ComposerSyncOverlay } from "./views/composer-overlays";

// Module-level frozen empty array so selectors that return a "default empty
// queue" hand back a stable reference instead of allocating per render.
const EMPTY_QUEUE: readonly string[] = Object.freeze([]);

interface MessageInputProps {
  tabId: string;
  /**
   * Send a message right now (used when idle, or to dequeue). Receives
   * the plain prose text, the list of mention records the user inserted,
   * and any staged image attachments — the panel-level handler composes
   * the final wire prompt and stages the images.
   */
  onSend: (message: string, mentions: MentionData[], attachments?: ImageAttachment[]) => void;
  /** Stop the current generation. */
  onStop?: () => void;
  /** Stop was clicked; awaiting the cancelled turn's terminal delta. */
  stopping?: boolean;
  /** True while the agent is producing a response. */
  running?: boolean;
  /** Hard-disable the composer (e.g. Claude Code isn't installed/authed). */
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({
  tabId,
  onSend,
  onStop,
  running = false,
  stopping = false,
  disabled: disabledProp = false,
  placeholder = "Message Atlas... (@ to mention, / for commands)",
}: MessageInputProps) {
  // The mode picker's self-heal and hung-boot backstop
  // (`use-composer-modes-self-heal.ts`).
  useComposerModesSelfHeal(tabId);
  // Narrow per-tab selectors — primitives only, no message-array refs. This
  // component otherwise would re-render on every streaming chunk because it
  // sits inside the active chat panel.
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  // Settings → General → "Enter to send". Narrow selector so a toggle flip
  // only re-renders composers, not the whole settings surface.
  const enterToSend = useSettingsStore((s) => s.settings.enterToSend);
  // `agentType` normalised for the composer sub-components (session scope,
  // agent switcher) + the label lookup. This used to be a hardcoded list of the
  // six first-party agents with everything else falling through to
  // "claude-code" — so every registry-installed agent showed up in the pill as
  // "Claude Code", and the grouped picker's current-agent highlight (and
  // session scope) pointed at the wrong agent. `switchableAgentOf` passes
  // external ids through and collapses only the legacy "custom" placeholder,
  // which is what the transcript and sidebar already did.
  const switchableAgent: SwitchableAgent = switchableAgentOf(agentType);

  // The org's AI grant, and the composer lock it drives.
  //
  // Owned here because this component always renders while a chat is open;
  // `AiGrantBar` below only reads the result (see `ai-grant-store.ts` for why
  // the two must not probe independently).
  useAiGrantProbe();
  useNativeModelsOrgRefresh();
  const noAiGrant = useNoAiGrant();
  // Scoped to the NATIVE agent, which is the only one that talks to the Atlas
  // gateway. Claude Code, Codex and every registry agent run on the user's own
  // credentials — an org with no AI grant says nothing about them, and locking
  // their composer would break agents that work fine.
  //
  // This is the one thing ADR-0002 permits: the ban is on a composer disabled
  // by an agent's *readiness*, because the agent switcher lives inside it. The
  // `disabled` path below pointer-blocks only the text area and the send
  // button — the toolbar, and with it the switcher, stays live, so the user can
  // always move to an agent that runs. Verified against the escape hatch: this
  // must never disable the toolbar.
  //
  // Never while a turn runs (`grantLocksComposer`): the lock used to disable
  // the Stop button of a turn already admitted when the answer turned to no.
  const blockedByGrant = grantLocksComposer(noAiGrant, agentType, running);
  // While the no-grant strip shows it is the only one: the native agent cannot
  // run at all, and any other notice above a locked input is noise beside it.
  const grantBarShown = useAiGrantBarShown(running) && agentType === "atlas-agent";
  const disabled = disabledProp || blockedByGrant;
  // A resume could not restore the user's mode (`ModeRestoreBar`): no send
  // until they pick one. Only the send — typing and the mode picker stay live.
  const modeUnrestored = useChatStore((s) => !!s.sessions[tabId]?.unrestoredModeId);
  // Another process is still writing this session: sends wait for "Send anyway".
  // The composer feeds the live set itself, so the guard holds whichever view
  // (sidebar, History, another project) the session was opened from.
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  // The same read keeps the session's attached projects current for the
  // project chips' access toggles (`session-projects-store`).
  useLiveElsewhereFeed(!!acpSessionId);
  const heldForTerminal = useSendHeldForTerminal(acpSessionId);
  // Someone else holds the session's remote-control seat (`RcDriverBar`):
  // nothing sends or queues from here until the owner takes over. Rust's
  // steering entry refuses it too; this is what lets the composer say so
  // rather than bounce an error. Stop stays live — it is the owner's.
  const remoteDriving = useRcRemoteDriver(acpSessionId) !== null;
  // The BYOK provider/model bindings for the native agent stood here — the
  // provider pick, the model re-push on bind, the whole BYOK selection path.
  // Gone: the native agent's model comes from the seam's published catalogue
  // through the same `setAcpModel` path every other agent uses, and its
  // "provider" is the Atlas gateway, which is not a choice.
  useNativeEffortSeed(tabId, agentType);
  // The RTK compression toggle was seeded and re-pushed here. It is gone with
  // the runtime that implemented it (#54) — the ported engine has no
  // tool-output compressor, so the control had nothing to switch (D8).
  // ACP-reported slash commands for this session. Every agent advertises its
  // real command list via `available_commands_update` — Codex's arrives with
  // the binding, Claude's a few seconds after session/new (the SDK discovers
  // skills/plugins/MCP prompts first), and the native agent's with its
  // session, published by the seam. Per ADR 0005 there is no fallback
  // catalogue: the picker shows a loading state (see `slashCommandsLoading`
  // below) during that gap instead.
  const availableCommands = useChatStore((s) => s.sessions[tabId]?.availableCommands);
  const slashCommandsLoading = availableCommands === undefined;
  const agentSlashCommands = useMemo<SlashCommand[]>(
    () => buildAgentSlashCommands(agentType, availableCommands),
    [agentType, availableCommands],
  );
  const queue = useChatStore((s) => s.queues[tabId] ?? EMPTY_QUEUE);

  // The editor owns the document; React only needs the empty↔non-empty EDGE
  // (for the submit button's tri-state), which the editor reports as an edge
  // (`onEmptyChange`) — a keystroke re-renders nothing here. The per-tab
  // draft mirror is `useComposerDraft`: a 300ms trailing debounce + a flush on
  // unmount (tab switches unmount this component, so nothing is lost; the
  // live-insert paths go through `atlas:chat-insert`, not the draft).
  const inputRef = useRef<ChatInputHandle>(null);
  const { setDraft } = useChatStore.use.actions();
  const draft = useComposerDraft(
    tabId,
    () => useChatStore.getState().drafts[tabId] ?? "",
    (text) => setDraft(tabId, text),
    () => inputRef.current?.getValue(),
  );
  const valueRef = draft.latest;
  const flushDraft = draft.flush;
  const [hasText, setHasText] = useState(() => draft.initialValue.trim().length > 0);
  const onEmptyChange = useCallback((blank: boolean) => setHasText(!blank), []);
  // Every programmatic rewrite — reply, prefill, insert, queue recall — goes
  // through here. Before the editor chunk has landed there is no editor to
  // write to, so the text waits in the draft and seeds the editor on mount.
  const writeComposer = useCallback(
    (text: string) => {
      const input = inputRef.current;
      if (input) {
        input.setValue(text);
        return;
      }
      valueRef.current = text;
      setHasText(text.trim().length > 0);
      setDraft(tabId, text);
    },
    [tabId, setDraft, valueRef],
  );

  // The editor chunk started downloading at module-eval time
  // (`use-lazy-composer-chunks.ts`).
  const { LazyChatInput, LazyMentionPicker, LazySlashPicker } = useLazyComposerChunks();

  // Fire `atlas:chat-input-focused` the first time this composer takes focus.
  // ChatPanel listens for it to lazily bind an ACP session — deferring the
  // agent spawn until the user actually intends to chat keeps it off the cold
  // boot path. Reset per tab so re-focusing a fresh tab still binds.
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    focusedOnceRef.current = false;
  }, [tabId]);
  const handleFocusCapture = useCallback(() => {
    // The toolbar (agent / model pickers) stays interactive while the composer
    // is disabled, so focus can now reach this handler from a control rather
    // than the text area. Don't kick off an agent bind against a CLI that
    // isn't ready — the user is most likely on their way to switching agents.
    if (disabled) return;
    if (focusedOnceRef.current) return;
    focusedOnceRef.current = true;
    window.dispatchEvent(new CustomEvent("atlas:chat-input-focused", { detail: { tabId } }));
  }, [tabId, disabled]);

  // ── Mention picker orchestration ──────────────────────────────────────
  const projectPath = useAppStore((s) => s.currentProject?.path ?? null);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const triggerRef = useRef<MentionTrigger | null>(null);
  triggerRef.current = trigger;

  // ── Slash-command picker orchestration ────────────────────────────────
  // The trigger changes on every keystroke while the picker is open, and this
  // component is the whole composer — editor shell, toolbar, tray, both
  // pickers. Held in React state, each keystroke re-rendered all of it. So it
  // lives in a store only the picker subscribes to (`SlashPickerHost`), and
  // this component re-renders on the open/close edge alone.
  const [slashStore] = useState(() => createValueStore<SlashTrigger | null>(null));
  const setSlashTrigger = slashStore.set;
  const slashOpen = useSyncExternalStore(slashStore.subscribe, () => slashStore.get() !== null);
  // A picker left open across an agent switch must not inherit the open
  // state; each agent's catalogue swaps in via `agentSlashCommands` above.
  useEffect(() => {
    slashStore.set(null);
  }, [agentType, slashStore]);
  const slashPickerRef = useRef<SlashCommandPickerHandle>(null);

  // The agent's own words from the last auth failure (`use-composer-auth-reason.ts`).
  const lastAuthReasonRef = useComposerAuthReason(tabId);

  const composerRef = useRef<HTMLDivElement>(null);
  // Images staged for the next send (`use-composer-images.ts`).
  const { stagedImages, setStagedImages, stagedRef, imageSupported } = useComposerImages(tabId);
  // Non-null (the repo's full_name) while a GitHub repo is cloning into
  // `.atlas/repos`. The composer is locked for the duration so the user can't
  // send a prompt that references a half-synced repo.
  const [githubSyncing, setGithubSyncing] = useState<string | null>(null);
  const {
    attachPicked,
    attachPaths,
    pickFilesOrPhotos,
    handlePickProject,
    pickMedia,
    handleTakeScreenshot,
    handleCloneRepo,
    handlePickSession,
    handlePasteImages,
    handlePasteLargeText,
  } = useComposerAttachments({
    tabId,
    inputRef,
    projectPath,
    imageSupported,
    setStagedImages,
    setGithubSyncing,
  });

  // Drag-and-drop from the OS. The zone is the whole conversation column
  // (`data-chat-drop-zone` in chat-panel.tsx), not this composer: a thin
  // target under a drag image that hangs off the cursor lit up and went dark
  // seemingly at random. Each split pane has its own column, so a drop still
  // lands in the pane under the cursor. Outside a chat panel, the composer.
  //
  // A drop is a pointing gesture — "this one, here, in the sentence I am
  // writing" — and `attachPaths` keeps that: the chip lands at the caret, and
  // an image's staged bytes ride along with it. The chip carries the
  // absolute path, which rides to the agent as an ACP `ResourceLink`
  // (`compose_prompt`) — every agent reads those.
  const dropZoneRef = useRef<HTMLElement | null>(null);
  const [dropZoneEl, setDropZoneEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    const zone = composer?.closest<HTMLElement>("[data-chat-drop-zone]") ?? composer ?? null;
    dropZoneRef.current = zone;
    setDropZoneEl(zone);
  }, []);
  const onDropFiles = useCallback((paths: string[]) => void attachPaths(paths), [attachPaths]);
  const { isDropTarget } = useComposerFileDrop({
    targetRef: dropZoneRef,
    enabled: !disabled,
    onDropFiles,
  });

  // Two forms. Focused, the input card with its toolbar tray tucked under
  // it; away from the composer, the input alone as a capsule, the tray slid
  // up behind it and the composer's height closed up after it. Anything in
  // the composer — text, a staged image, a queued message, an open picker or
  // menu — keeps it open, so nothing is hidden mid-task.
  const collapsible =
    !hasText &&
    stagedImages.length === 0 &&
    queue.length === 0 &&
    trigger === null &&
    !slashOpen &&
    githubSyncing === null &&
    !isDropTarget;
  const inputCardRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const { setComposerFocused, collapsed, trayShown, onComposerBlur } = useComposerFocus({
    composerRef,
    collapsible,
    inputCardRef,
    trayRef,
  });

  // "+" menu footer → agent switcher. Same helper as ⌥/ and the agent pill,
  // but jumps straight to the picked agent instead of cycling.
  const handleSwitchAgent = useCallback(
    (next: SwitchableAgent, model?: string) => switchAgentForTab(tabId, next, { model }),
    [tabId],
  );

  // The draft mirror's doc listener, plus pruning: a chip the user deleted
  // (Backspace, ⌘Z, a cleared draft) takes its staged image with it. Checked
  // only while an image is staged, so the common keystroke pays nothing.
  const { onDocChange: mirrorDraft } = draft;
  const handleDocChange = useCallback(() => {
    mirrorDraft();
    if (!stagedRef.current.some((img) => img.path)) return;
    const input = inputRef.current;
    if (!input) return;
    setStagedImages((prev) => {
      const next = prev.filter((img) => !img.path || input.hasMention("file", img.path));
      return next.length === prev.length ? prev : next;
    });
  }, [mirrorDraft]);

  // `submit` (below) is defined after `handleSlashSelect` but the latter
  // needs to invoke it — routed through a ref (set right after `submit` is
  // declared) rather than a direct reference, since a `useCallback` deps
  // array is evaluated eagerly on every render and would otherwise read
  // `submit` before its `const` initializes.
  const submitRef = useRef<() => void>(() => {});

  const { handleMentionSelect, handleSlashSelect, keyInterceptor } = useComposerPickers({
    tabId,
    agentType,
    disabled,
    inputRef,
    pickerRef,
    triggerRef,
    setTrigger,
    slashStore,
    slashPickerRef,
    lastAuthReasonRef,
    submitRef,
    attachPicked,
  });

  useComposerEvents({
    tabId,
    LazyChatInput,
    inputRef,
    valueRef,
    writeComposer,
    disabled,
    flushDraft,
  });

  const submit = useCallback(() => {
    // Hard gate: Claude Code missing or not authed — sending would just
    // surface a confusing ACP spawn error. The banner above tells the user
    // what to do instead.
    if (disabled) return;
    // A GitHub repo is still syncing into `.atlas/repos` — block the send so the
    // prompt can't reference a half-cloned repo.
    if (githubSyncing !== null) return;
    const text = inputRef.current?.getValue() ?? valueRef.current;
    const trimmed = text.trim();
    if (!trimmed) {
      // Empty + running → act as a stop button.
      if (running) onStop?.();
      return;
    }
    // Someone else holds the seat: nothing typed here sends or queues, not
    // even `/queue` (which used to slip past this check and park the prompt
    // locally, to be drained under the remote driver's seat later). The
    // strip above says who is driving and offers Take over.
    if (remoteDriving) return;
    // Atlas-surface commands, typed in full (the picker's Enter lands here
    // too). They drive app affordances, so they never reach the agent.
    if (trimmed === "/fork" && agentCatalogEntry(agentType)?.supportsFork === true) {
      forkSessionToNewTab(tabId);
      writeComposer("");
      return;
    }
    if (trimmed === "/queue" || trimmed.startsWith("/queue ")) {
      const queued = trimmed.slice("/queue".length).trim();
      if (queued) {
        const mentions = inputRef.current?.getMentions() ?? [];
        enqueuePrompt(tabId, queued, mentions);
        forgetSentTexts(mentions);
      }
      writeComposer("");
      return;
    }
    const mentions = inputRef.current?.getMentions() ?? [];
    if (running) {
      // Queued messages don't carry mentions yet — the queue holds raw
      // strings and the agent will see whatever shortform text was in the
      // composer. Mentions are dropped here intentionally; promoting the
      // queue to a structured shape is a follow-up. Staged images likewise
      // stay in the composer strip and ride the next direct send. A paste or
      // a cite is the exception: its token alone would lose what the user
      // pasted or cited, so the queue puts its text into the queued string.
      enqueuePrompt(tabId, trimmed, mentions);
      forgetSentTexts(mentions);
    } else {
      if (modeUnrestored || heldForTerminal) return;
      // The wire shape is mime + bytes; the path stays with the composer.
      const images = stagedImages.map(({ path: _path, ...img }) => img);
      onSend(trimmed, mentions, images.length ? images : undefined);
      forgetSentTexts(mentions);
      if (images.length) setStagedImages([]);
    }
    // Through `setValue`, not `clear`, so the send is one undo step away.
    writeComposer("");
    // The debounced draft mirror will collapse the empty value into a
    // `delete s.drafts[tabId]`, so no explicit clearDraft call is needed.
  }, [
    writeComposer,
    valueRef,
    running,
    onSend,
    onStop,
    tabId,
    agentType,
    disabled,
    stagedImages,
    githubSyncing,
    modeUnrestored,
    heldForTerminal,
    remoteDriving,
  ]);
  submitRef.current = submit;

  // Tri-state button:
  //   running + empty   → STOP
  //   running + text    → QUEUE  (STOP while someone else drives: queueing is
  //                               theirs, Stop is the owner's, and a draft
  //                               must not hide the one control that works)
  //   not running + any → SEND
  type Mode = "send" | "queue" | "stop";
  const mode: Mode = running ? (hasText && !remoteDriving ? "queue" : "stop") : "send";
  const buttonEnabled =
    disabled ||
    (mode === "send" && (modeUnrestored || heldForTerminal)) ||
    (mode !== "stop" && remoteDriving)
      ? false
      : mode === "stop"
        ? true
        : hasText;

  // One fixed placeholder, always. The composer used to swap in a queue hint
  // while a turn ran and a no-grant explanation when AI access was missing;
  // both restated what the surface above the input already says (the queued
  // chip, the grant bar), and the swapping read as the composer changing its
  // mind. The setup pill and grant bar own that messaging.
  const effectivePlaceholder = placeholder;

  return (
    <div className="pb-4 pt-2 bg-transparent">
      <div className={CONTENT_COLUMN}>
        {/* Queued messages above the input */}
        {queue.length > 0 && (
          <ComposerQueue
            queue={queue}
            remoteDriving={remoteDriving}
            onEdit={(q, i) => {
              const cur = inputRef.current?.getValue() ?? "";
              // A paste or a cite the queue inlined comes back as its
              // chip, not as every line it holds. Cites were written
              // last, so they come off first.
              const uncited = collapseCites(q);
              const { text, pastes } = collapsePastes(uncited.text);
              for (const p of pastes) rememberMention(p, projectPath);
              for (const c of uncited.cites) rememberMention(c, projectPath);
              const merged = cur.trim() ? `${cur}\n${text}` : text;
              writeComposer(merged);
              removeQueuedPrompt(tabId, i);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            onRemove={(i) => removeQueuedPrompt(tabId, i)}
          />
        )}

        <ComposerNotices
          tabId={tabId}
          agentType={agentType}
          running={running}
          grantBarShown={grantBarShown}
        />

        {/* Live plan docked on top of the input bar (JetBrains-Air style). */}

        <div
          ref={composerRef}
          data-chat-composer
          data-tip-anchor="composer"
          data-collapsed={collapsed || undefined}
          className={cn(
            // Positioned + z-indexed so the composer paints over — and visually
            // tucks — the PlanDock's bottom edge (the attached-panel recipe).
            //
            // The VALUE has to clear the floating pill row above the composer
            // (`z-20` in chat-panel.tsx), not just the PlanDock. This element
            // has a z-index, so it opens a stacking context, and every dropup
            // inside it — the model picker, the agent/mode picker, the toolbar
            // tooltip — is trapped in it: their `z-popover` sorts them against
            // each other and against nothing else. At `z-10` the whole composer,
            // menus included, painted UNDER the "Scroll to bottom" pill, which
            // also swallowed clicks on the menu's first row (the pill sets
            // `pointer-events-auto`). Raising the context is the fix; raising
            // the menus themselves cannot work from inside it.
            // The shell draws nothing: the input card is a surface of its own
            // and the toolbar a tray tucked under it (a muted outer card
            // around both is gone).
            "relative z-30",
            // The footer pills' labels collapse against THIS width.
            "@container",
            // NOTE: the disabled dim is NOT applied here. It used to be
            // (`disabled && "opacity-60"` on this shell), and it faded the
            // whole composer — footer pills, the agent switcher, and every
            // dropup, since the menus are absolutely-positioned CHILDREN of
            // this element (not portals) and inherit its opacity. The escape
            // hatch has to look reachable, not just be reachable, so the dim
            // now lives on the inner input surface alone.
            // Lock the composer while a GitHub repo syncs into `.atlas/repos`.
            githubSyncing !== null && "opacity-60 pointer-events-none",
          )}
          onFocusCapture={() => {
            setComposerFocused(true);
            handleFocusCapture();
            useTipsStore.getState().actions.request("composer");
          }}
          onBlurCapture={onComposerBlur}
          // A press anywhere in it is being in it, focus or not (see above).
          onPointerDownCapture={() => setComposerFocused(true)}
          // A press on the composer's own surface — the tray's padding, the
          // gaps between pills — keeps focus where it is. Left alone, it
          // moved focus to <body>, which folded the composer under the click.
          onMouseDown={(e) => {
            const target = e.target as Element;
            if (
              !target.closest(
                "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='menuitem'], [tabindex]",
              )
            ) {
              e.preventDefault();
            }
          }}
          // Esc folds it, as clicking away does. Caught on the way DOWN:
          // ProseMirror marks Esc handled in the editor, so it never
          // bubbles back out unprevented. An open picker or menu keeps the
          // composer from folding (`collapsible`), and is left its own Esc.
          onKeyDownCapture={(e) => {
            if (e.key !== "Escape" || !collapsible) return;
            // A tray dropup (agent, model, options) that is open takes Esc to
            // close itself.
            if (e.currentTarget.querySelector("[data-popup-open], [aria-expanded='true']")) return;
            (document.activeElement as HTMLElement | null)?.blur();
            setComposerFocused(false);
          }}
        >
          {githubSyncing !== null && <ComposerSyncOverlay repo={githubSyncing} />}
          {dropZoneEl && <ComposerDropOverlay zone={dropZoneEl} active={isDropTarget} />}
          <ComposerInputCard
            cardRef={inputCardRef}
            collapsed={collapsed}
            disabled={disabled}
            editor={
              LazyChatInput ? (
                <SessionProjectsContext.Provider value={acpSessionId ?? null}>
                  <LazyChatInput
                    ref={inputRef}
                    initialValue={valueRef.current}
                    placeholder={effectivePlaceholder}
                    projectPath={projectPath}
                    onEmptyChange={onEmptyChange}
                    onDocChange={handleDocChange}
                    onSubmit={submit}
                    enterToSend={enterToSend}
                    onMentionTrigger={setTrigger}
                    onSlashTrigger={setSlashTrigger}
                    onPasteImages={handlePasteImages}
                    onPastePaths={attachPaths}
                    onPasteLargeText={handlePasteLargeText}
                    keyInterceptor={keyInterceptor}
                  />
                </SessionProjectsContext.Provider>
              ) : (
                // Same-height empty slot so the panel layout doesn't reflow when
                // the editor lands. Non-interactive — by the time the user can
                // visually find this region the chunk has typically resolved.
                <div aria-hidden="true" style={{ minHeight: 44 }} className="px-4 pt-3 pb-1" />
              )
            }
            mode={mode}
            stopping={stopping}
            enterToSend={enterToSend}
            buttonEnabled={buttonEnabled}
            onSubmit={submit}
          />
          <ComposerTray
            tabId={tabId}
            agentType={agentType}
            switchableAgent={switchableAgent}
            trayRef={trayRef}
            trayShown={trayShown}
            collapsed={collapsed}
            disabledProp={disabledProp}
            githubSyncing={githubSyncing}
            imageSupported={imageSupported}
            pickFilesOrPhotos={pickFilesOrPhotos}
            pickMedia={pickMedia}
            handleTakeScreenshot={handleTakeScreenshot}
            handleCloneRepo={handleCloneRepo}
            handlePickSession={handlePickSession}
            handlePickProject={handlePickProject}
            handleSwitchAgent={handleSwitchAgent}
          />
        </div>
      </div>
      {LazyMentionPicker && (
        <LazyMentionPicker
          ref={pickerRef}
          open={trigger !== null}
          query={trigger?.query ?? ""}
          anchor={trigger?.anchor ?? null}
          initialScope={trigger?.scope ?? null}
          projectPath={projectPath}
          // Per-agent component gating: pack components (command/agent/rule)
          // only list ones enabled for the active agent (registry ids
          // "claude-code" / "codex" match agentType).
          agentId={agentType}
          tabId={tabId}
          onSelect={handleMentionSelect}
          onClose={() => setTrigger(null)}
        />
      )}
      {LazySlashPicker && (
        <SlashPickerHost
          Picker={LazySlashPicker}
          store={slashStore}
          pickerRef={slashPickerRef}
          onSelect={handleSlashSelect}
          commands={agentSlashCommands}
          loading={slashCommandsLoading}
          // One resolver instead of an if-ladder that missed the native agent
          // (it fell through to the picker's "Claude Code commands" default).
          footerLabel={`${agentMeta(agentType).label} commands`}
        />
      )}
    </div>
  );
}
