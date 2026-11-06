import { useTipsStore } from "@/features/tips/stores/tips-store";
import { useRef } from "react";
import { CONTENT_COLUMN } from "../lib/row-metrics";
import { useChatStore } from "../stores/chat-store";
import { removeQueuedPrompt } from "../lib/turn-queue";
// The editor (`ChatInput`) and both pickers load as their own chunks
// (`use-lazy-composer-chunks.ts`); only their types are imported here.
import type { ChatInputHandle } from "./chat-input";
import { SessionProjectsContext } from "../hooks/use-session-projects";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { ImageAttachment } from "@/types/agents";
import { useAppStore } from "@/features/app/stores/app-store";
// Value imports from the composer stay editor-free: anything that imports
// Tiptap at module scope would pull it into this eager module's graph and
// defeat the dynamic `import("./chat-input")` boundary.
import type { MentionData } from "../lib/mentions";
import { submitButtonState } from "../lib/composer-submit";
import { useComposerGates } from "../hooks/use-composer-gates";
import { useComposerText } from "../hooks/use-composer-text";
import { useLazyComposerChunks } from "../hooks/use-lazy-composer-chunks";
import { useComposerImages } from "../hooks/use-composer-images";
import { useComposerAttachments } from "../hooks/use-composer-attachments";
import { useComposerDropZone } from "../hooks/use-composer-file-drop";
import { useChatInputFocusedSignal, useComposerFocus } from "../hooks/use-composer-focus";
import { useComposerPickers } from "../hooks/use-composer-pickers";
import { useComposerEvents } from "../hooks/use-composer-events";
import { useComposerSubmit } from "../hooks/use-composer-submit";
import { ComposerPickers } from "./composer-pickers";
import { ComposerNotices } from "./composer-notices";
import { ComposerTray } from "./composer-tray";
import { ComposerQueue } from "./views/composer-queue";
import { ComposerInputCard } from "./views/composer-input-card";
import { ComposerDropOverlay, ComposerSyncOverlay } from "./views/composer-overlays";
import { ComposerShell } from "./views/composer-shell";

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
  // The session's agent and every gate on the send (`use-composer-gates.ts`).
  const gates = useComposerGates({ tabId, running, disabledProp });
  const { agentType, disabled, modeUnrestored, heldForTerminal, remoteDriving } = gates;
  // Settings → General → "Enter to send". Narrow selector so a toggle flip
  // only re-renders composers, not the whole settings surface.
  const enterToSend = useSettingsStore((s) => s.settings.enterToSend);
  const queue = useChatStore((s) => s.queues[tabId] ?? EMPTY_QUEUE);

  const inputRef = useRef<ChatInputHandle>(null);
  const projectPath = useAppStore((s) => s.currentProject?.path ?? null);
  // The draft mirror and every programmatic write (`use-composer-text.ts`).
  const { draft, valueRef, hasText, onEmptyChange, writeComposer, editQueued } = useComposerText({
    tabId,
    inputRef,
    projectPath,
  });

  // The editor chunk started downloading at module-eval time
  // (`use-lazy-composer-chunks.ts`).
  const { LazyChatInput, LazyMentionPicker, LazySlashPicker } = useLazyComposerChunks();

  const handleFocusCapture = useChatInputFocusedSignal(tabId, disabled);

  const composerRef = useRef<HTMLDivElement>(null);
  // Images staged for the next send (`use-composer-images.ts`).
  const { stagedImages, setStagedImages, imageSupported, handleDocChange } = useComposerImages({
    tabId,
    inputRef,
    mirrorDraft: draft.onDocChange,
  });
  // Every way something gets attached (`use-composer-attachments.ts`).
  const attach = useComposerAttachments({
    tabId,
    inputRef,
    projectPath,
    imageSupported,
    setStagedImages,
  });
  const { githubSyncing, attachPaths } = attach;

  // Both pickers' open state and what a pick does (`use-composer-pickers.ts`).
  const pickers = useComposerPickers({
    tabId,
    agentType,
    disabled,
    inputRef,
    attachPicked: attach.attachPicked,
  });
  const { trigger } = pickers;

  const { dropZoneEl, isDropTarget } = useComposerDropZone({ composerRef, disabled, attachPaths });

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
    !pickers.slashOpen &&
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

  useComposerEvents({
    tabId,
    LazyChatInput,
    inputRef,
    valueRef,
    writeComposer,
    disabled,
    flushDraft: draft.flush,
  });

  const submit = useComposerSubmit({
    tabId,
    agentType,
    inputRef,
    valueRef,
    writeComposer,
    stagedImages,
    setStagedImages,
    disabled,
    githubSyncing,
    running,
    remoteDriving,
    modeUnrestored,
    heldForTerminal,
    onSend,
    onStop,
  });
  pickers.submitRef.current = submit;

  const { mode, enabled: buttonEnabled } = submitButtonState({
    running,
    hasText,
    disabled,
    modeUnrestored,
    heldForTerminal,
    remoteDriving,
  });

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
            onEdit={editQueued}
            onRemove={(i) => removeQueuedPrompt(tabId, i)}
          />
        )}

        <ComposerNotices
          tabId={tabId}
          agentType={agentType}
          running={running}
          grantBarShown={gates.grantBarShown}
        />

        {/* Live plan docked on top of the input bar (JetBrains-Air style). */}

        <ComposerShell
          composerRef={composerRef}
          collapsed={collapsed}
          collapsible={collapsible}
          locked={githubSyncing !== null}
          onFocusCapture={() => {
            setComposerFocused(true);
            handleFocusCapture();
            useTipsStore.getState().actions.request("composer");
          }}
          onBlurCapture={onComposerBlur}
          onPress={() => setComposerFocused(true)}
          onFold={() => setComposerFocused(false)}
        >
          {githubSyncing !== null && <ComposerSyncOverlay repo={githubSyncing} />}
          {dropZoneEl && <ComposerDropOverlay zone={dropZoneEl} active={isDropTarget} />}
          <ComposerInputCard
            cardRef={inputCardRef}
            collapsed={collapsed}
            disabled={disabled}
            editor={
              LazyChatInput ? (
                <SessionProjectsContext.Provider value={gates.acpSessionId ?? null}>
                  <LazyChatInput
                    ref={inputRef}
                    initialValue={valueRef.current}
                    placeholder={effectivePlaceholder}
                    projectPath={projectPath}
                    onEmptyChange={onEmptyChange}
                    onDocChange={handleDocChange}
                    onSubmit={submit}
                    enterToSend={enterToSend}
                    onMentionTrigger={pickers.setTrigger}
                    onSlashTrigger={pickers.setSlashTrigger}
                    onPasteImages={attach.handlePasteImages}
                    onPastePaths={attachPaths}
                    onPasteLargeText={attach.handlePasteLargeText}
                    keyInterceptor={pickers.keyInterceptor}
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
            switchableAgent={gates.switchableAgent}
            trayRef={trayRef}
            trayShown={trayShown}
            collapsed={collapsed}
            disabledProp={disabledProp}
            githubSyncing={githubSyncing}
            imageSupported={imageSupported}
            pickFilesOrPhotos={attach.pickFilesOrPhotos}
            pickMedia={attach.pickMedia}
            handleTakeScreenshot={attach.handleTakeScreenshot}
            handleCloneRepo={attach.handleCloneRepo}
            handlePickSession={attach.handlePickSession}
            handlePickProject={attach.handlePickProject}
          />
        </ComposerShell>
      </div>
      <ComposerPickers
        tabId={tabId}
        agentType={agentType}
        projectPath={projectPath}
        pickers={pickers}
        LazyMentionPicker={LazyMentionPicker}
        LazySlashPicker={LazySlashPicker}
      />
    </div>
  );
}
