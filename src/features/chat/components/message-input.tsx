import {
  memo,
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { cn } from "@/lib/utils";
import { CONTENT_COLUMN } from "../lib/row-metrics";
import { insertedDraft, type ChatInsertDetail } from "../lib/response-selection";
import { Hint } from "@/ui/tooltip";
import {
  ArrowUp,
  Square,
  Pencil,
  X,
  Check,
  Loader2,
  Brain,
  ChevronDown,
  Plus,
  RotateCw,
  AtSign,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../stores/chat-store";
import { useNativeModelsOrgRefresh, useNativeModelsStore } from "../stores/native-models-store";
import { agents } from "../lib/agents-api";
import { enqueuePrompt, removeQueuedPrompt } from "../lib/turn-queue";
import {
  CLAUDE_PERMISSION_MODE_LABEL,
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionMode,
  agentTypeFromPluginId,
  type SwitchableAgent,
} from "@/types/agent";
import {
  agentMeta,
  catalogEntry as agentCatalogEntry,
  switchableAgentOf,
  useSwitchableAgents,
} from "@/features/agents/lib/agent-meta";
import { canSignIn, promptSignIn } from "../lib/agent-signin";
import { forkSessionToNewTab } from "../lib/fork-session";
import {
  SESSION_HANDOFF_EVENT,
  switchAgentForTab,
  type SessionHandoffDetail,
} from "@/features/chat/lib/switch-agent";
import { AgentMark } from "@/components/agent-mark";
import { loadNativeEffort } from "../lib/native-model-pref";
import { loadCachedAcpModels } from "../lib/acp-models-cache";
import { capitalizeModelName, modelLabel } from "../lib/model-label";
import { ModelPicker, type PickerAgent } from "./model-picker";
import { onModelPickerRequest } from "../lib/model-picker-events";
// `ChatInput` pulls in Tiptap and ProseMirror (the shared composer core).
// We import it dynamically so the chunk is not in the initial preload set.
// The import is kicked off at module-evaluation time (below, outside the
// component) so the chunk starts downloading the moment this module is
// reached in the import graph — *before* MessageInput even mounts. Until
// the chunk resolves the composer renders a same-sized empty placeholder
// so the panel doesn't reflow when the editor lands.
//
// `MentionPicker` only mounts when the user types `@`, so we let its chunk
// load purely on demand — no eager preload (that would add a wasted Vite
// roundtrip in dev for every MessageInput mount).
import type {
  ChatInput as ChatInputComponent,
  ChatInputHandle,
  MentionTrigger,
  SlashTrigger,
} from "./chat-input";
import type {
  MentionPicker as MentionPickerComponent,
  MentionPickerHandle,
} from "@/features/mentions/components/mention-picker";
import type {
  SlashCommandPicker as SlashCommandPickerComponent,
  SlashCommandPickerHandle,
  SlashCommand,
} from "./slash-command-picker";
import { commandRequiresArgs } from "./slash-command-picker";
import { PlanTasksPill } from "./plan-tasks-pill";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { ComposerOptionsPill } from "./composer-options-pill";
import { UsagePill } from "./usage-pill";
import { composerPillLabelClass } from "./composer-dropup";
import { FeaturedAgentOffers } from "./featured-agent-offers";
import { RetryPill } from "./retry-pill";
import { SleepPill } from "./sleep-pill";
import { AiGrantBar, useAiGrantBarShown } from "./ai-grant-bar";
import { RemovedAgentBar } from "./removed-agent-bar";
import { BranchChangedBar } from "./branch-changed-bar";
import { ModeRestoreBar, OPEN_MODE_PICKER_EVENT } from "./mode-restore-bar";
import { LiveElsewhereBar } from "./live-elsewhere-bar";
import { RcDriverBar } from "./rc-driver-bar";
import { useRcRemoteDriver } from "../stores/rc-store";
import { useSendHeldForTerminal } from "../stores/live-elsewhere-store";
import { useSessionProjectsStore } from "../stores/session-projects-store";
import { SessionProjectsContext } from "../hooks/use-session-projects";
import { attachSessionProject, type AttachSource } from "../lib/session-projects-api";
import { useLiveElsewhereFeed } from "../hooks/use-live-elsewhere-feed";
import { grantLocksComposer, useAiGrantProbe, useNoAiGrant } from "../stores/ai-grant-store";
import {
  QUALITY_LADDER,
  aggregateExceedsBudget,
  exceedsBudget,
  targetDimensions,
} from "../lib/image-policy";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { ComposerAddMenu } from "./composer-add-menu";
import type { GithubRepo } from "@/features/github/types";
import { metaFromSearch } from "@/features/github/types";
import { imageMimeFromPath } from "@/lib/byok/model-capabilities";
import type { ImageAttachment } from "@/types/agents";
import type {
  MentionFile,
  MentionProject,
  MentionRepo,
  MentionPastSession,
  PastSessionRef,
} from "../lib/mentions";
import { toast } from "sonner";
import { useComposerFileDrop } from "../hooks/use-composer-file-drop";
import { useComposerFold } from "../hooks/use-composer-fold";
import { scratchPathForFile } from "@/lib/scratch-file";
import { useAppStore } from "@/features/app/stores/app-store";
// Value imports from the composer stay editor-free: anything that imports
// Tiptap at module scope would pull it into this eager module's graph and
// defeat the dynamic `import("./chat-input")` boundary below.
import { useComposerDraft } from "@/components/composer/use-composer-draft";
import type { MentionData } from "../lib/mentions";
import { COMMENT_LINK_EVENT, type CommentLinkDetail } from "../lib/comment-mentions";
import { collapsePastes, pastedTextMention } from "../lib/pasted-text";
import { collapseCites } from "../lib/cited-text";
import { REVIEW_UNLINK_EVENT, type ReviewUnlinkDetail } from "../lib/review-comments";
import { forgetSentTexts, rememberMention } from "../lib/mention-registry";

// Start the editor chunk download at module-evaluation time. Vite still
// excludes it from `<link rel="modulepreload">` because the static analysis
// only sees a dynamic `import()`. The promise is reused by every MessageInput
// instance.
const chatInputPromise: Promise<typeof import("./chat-input")> = import("./chat-input");
const mentionPickerPromise: Promise<
  typeof import("@/features/mentions/components/mention-picker")
> = import("@/features/mentions/components/mention-picker");
const slashCommandPickerPromise: Promise<typeof import("./slash-command-picker")> =
  import("./slash-command-picker");

// Module-level frozen empty array so selectors that return a "default empty
// queue" hand back a stable reference instead of allocating per render.
const EMPTY_QUEUE: readonly string[] = Object.freeze([]);

/** A staged image: the wire attachment, plus the file it is, which joins it
 *  to its chip in the prompt (`attachPaths`). */
type StagedImage = ImageAttachment & { path: string };

/**
 * Shrink an attachment that would not fit the gateway's body cap (D15c).
 *
 * Done once, here, rather than on every turn: the engine replays the whole
 * conversation on each request, so an image re-encoded on the way out would be
 * re-encoded for as long as the thread lives.
 *
 * Failure is not fatal. A browser that cannot decode the image, or a canvas
 * that will not export, leaves the original in place — a too-large attachment
 * that the gateway refuses with a clear `413` is a better outcome than an
 * attachment silently dropped on the floor here.
 */
async function downscaleAttachment(image: ImageAttachment): Promise<ImageAttachment> {
  if (!exceedsBudget(image.dataBase64.length)) return image;
  try {
    const source = `data:${image.mimeType};base64,${image.dataBase64}`;
    const bitmap = await createImageBitmap(await (await fetch(source)).blob());
    const target = targetDimensions(bitmap.width, bitmap.height);
    const width = target?.width ?? bitmap.width;
    const height = target?.height ?? bitmap.height;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return image;
    // A fresh canvas is transparent and JPEG has no alpha channel, so
    // transparent pixels composite to BLACK — a macOS window capture (rounded
    // corners, drop shadow, routinely over budget) came out with black
    // corners and a black halo (#71). Paint the ground white first.
    // ratchet-allow: the JPEG ground for a window capture (#71), not app chrome.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    // Down the quality ladder until it fits. A legible 400 KB JPEG beats a
    // pristine 6 MB PNG the gateway refuses outright.
    for (const quality of QUALITY_LADDER) {
      const encoded = canvas.toDataURL("image/jpeg", quality);
      const data = encoded.slice(encoded.indexOf(",") + 1);
      if (!exceedsBudget(data.length)) {
        return { mimeType: "image/jpeg", dataBase64: data };
      }
    }
    return image;
  } catch {
    return image;
  }
}

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

/**
 * Per-mode dot color for the generic ACP permission picker, mirroring Claude's
 * semantic scale: restrictive = blue, auto-edit = green, unrestricted = red.
 * Keyed off the agent-advertised mode id (Codex: read-only / auto / full-access)
 * with broad fallbacks so other agents' modes still get a sensible tint.
 */
function acpModeColor(modeId: string | undefined): string {
  const id = (modeId ?? "").toLowerCase();
  if (/full|bypass|\ball\b|danger|yolo|unrestricted/.test(id))
    return "var(--atlas-status-error-foreground)";
  if (/read.?only|\bplan\b|ask|suggest/.test(id)) return "var(--primary)";
  if (/auto|default|edit|accept|agent|project/.test(id))
    return "var(--atlas-status-success-foreground)";
  return "var(--muted-foreground)";
}

const EFFORT_CYCLE = ["", "low", "medium", "high", "max"] as const;

/** Reasoning-effort pill for the native agent on Anthropic models (maps to a
 *  thinking budget). Cycles off → low → medium → high → max. Hidden for
 *  providers that don't support a thinking budget. */
function EffortPill({ tabId }: { tabId: string }) {
  const provider = useChatStore((s) => s.sessions[tabId]?.nativeProvider ?? "");
  const effort = useChatStore((s) => s.sessions[tabId]?.nativeEffort ?? "");
  const { setNativeEffort } = useChatStore.use.actions();
  if (provider !== "anthropic") return null;
  const cycle = () => {
    const i = EFFORT_CYCLE.indexOf(effort as (typeof EFFORT_CYCLE)[number]);
    setNativeEffort(tabId, EFFORT_CYCLE[(i + 1) % EFFORT_CYCLE.length]);
  };
  const active = effort !== "";
  return (
    <button
      onClick={cycle}
      className="flex items-center px-2 h-6.5 rounded-full border border-[var(--border)] bg-[var(--card)] text-2xs leading-none font-medium text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
      title="Reasoning effort (thinking budget) — Anthropic models"
    >
      <Brain
        size={11}
        className={active ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}
      />
      <span className={composerPillLabelClass("early")}>
        {active ? `Think: ${effort}` : "Think"}
      </span>
    </button>
  );
}

/**
 * Composer permission-mode picker for non-Claude ACP agents (Codex). Unlike
 * Claude's fixed 4-mode cycling pill, the modes here are agent-advertised
 * (id + name + description), so this renders a dropup popover listing them.
 * Self-contained: own narrow store selectors + click-outside, so it doesn't
 * widen MessageInput's render surface.
 */
/** Mode names arrive verbatim from the agent — OpenCode sends lowercase ids as
 *  names ("build", "plan"). Title-case a single all-lowercase word for display;
 *  multi-word or already-cased names (Claude's "Accept Edits") pass through. */
function displayModeName(name: string): string {
  return /^[a-z][a-z0-9-]*$/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

type ComposerGroup = "model" | "mode";
const GROUP_ORDER: ComposerGroup[] = ["model", "mode"];

/** Colour class for the Claude permission-mode dot (mirrors the old pill). */
function claudeModeDotClass(mode: ClaudePermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "bg-[var(--atlas-status-success-foreground)]";
    case "plan":
      return "bg-[var(--primary)]";
    case "bypassPermissions":
      return "bg-[var(--atlas-status-error-foreground)]";
    case "auto":
      return "bg-[var(--atlas-status-warning-foreground)]";
    default:
      return "bg-[var(--muted-foreground)]";
  }
}

/**
 * The composer's grouped, animated picker — coding agent / permission mode /
 * model unified into one expanding menu. The pill row doubles as
 * the tab strip: clicking a pill expands a shared panel above it with that
 * group's items; clicking another tab slides the content toward it
 * (direction-aware); outside click / Esc / re-click closes. While open, the
 * unselected pills collapse to icon-only (the reference's tab behaviour).
 * Keyboard cycling (⌥/ agents, ⇧⇥ modes) is unchanged — this is the
 * "just let me pick" surface.
 *
 * Animation is CSS-only and cheap: the expand is a grid-rows 0fr→1fr
 * transition (no measuring, no library), group switches are one-shot keyed
 * slide-ins that end at identity (no fill-mode — the standing rule).
 */
function ComposerGroupsMenu({
  tabId,
  currentAgent,
  onSwitchAgent,
}: {
  tabId: string;
  currentAgent: SwitchableAgent;
  onSwitchAgent: (agent: SwitchableAgent, model?: string) => void;
}) {
  const cycleAgentHint = useActionShortcut("chat.cycleAgent")?.label;
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  const permissionMode = useChatStore((s) => s.sessions[tabId]?.claudePermissionMode ?? "default");
  const currentMode = useChatStore((s) => s.sessions[tabId]?.acpCurrentMode);
  const availableModes = useChatStore((s) => s.sessions[tabId]?.acpAvailableModes);
  // The agent's own knobs are NOT here: they render as <ComposerOptionsPill/>
  // on the right of the footer, next to the plan pill.
  const modesPending = useChatStore((s) => s.sessions[tabId]?.acpModesPending ?? false);
  const currentModel = useChatStore((s) => s.sessions[tabId]?.acpCurrentModel);
  const availableModels = useChatStore((s) => s.sessions[tabId]?.acpAvailableModels);
  const { setAcpMode, setAcpModel, setClaudePermissionMode } = useChatStore.use.actions();
  const switchableAgents = useSwitchableAgents();

  const [openGroup, setOpenGroup] = useState<ComposerGroup | null>(null);
  const [dir, setDir] = useState(1);
  const ref = useRef<HTMLDivElement>(null);
  // Measured content height driving the shared panel's height tween — group
  // switches (and async rows landing) morph the container instead of snapping.
  const contentRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelHeight(el.offsetHeight));
    ro.observe(el);
    setPanelHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [openGroup]);

  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenGroup(null);
    };
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== "groups") setOpenGroup(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("atlas:composer-menu-open", onOther);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("atlas:composer-menu-open", onOther);
    };
  }, [openGroup]);

  // "Choose mode" on the mode-restore bar opens the mode group from outside.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ tabId?: string }>).detail?.tabId !== tabId) return;
      setOpenGroup("mode");
      // Mutual exclusion with the + menu — see atlas:composer-menu-open.
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "groups" }));
    };
    window.addEventListener(OPEN_MODE_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_MODE_PICKER_EVENT, onOpen);
  }, [tabId]);

  // ⌘⇧M (`chat.toggleModelPicker`, dispatched by the chat panel) toggles the
  // model group, as the reference's model-picker chord does.
  useEffect(
    () =>
      onModelPickerRequest(tabId, () =>
        setOpenGroup((cur) => {
          if (cur === "model") return null;
          window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "groups" }));
          return "model";
        }),
      ),
    [tabId],
  );

  const isNative = agentType === "atlas-agent";
  const refreshingModels = useNativeModelsStore.use.refreshing();
  const refreshNativeModels = useNativeModelsStore.use.actions().refresh;

  // Self-heal: the store is fed by the bind-time snapshot and the
  // `config_options_updated` delta, and a tab can render before either has
  // landed. Fall back to the persisted per-agent cache so the pill does not
  // flicker away in that gap.
  //
  // Not for the native agent. Its list is the gateway's, fetched and cached
  // by the seam (ADR-0007), and it arrives with the bind-time snapshot; when
  // it does NOT arrive that is the failure the user must see — an empty
  // picker with the refresh hint — and a localStorage pre-fill would paper
  // over it with whatever list some earlier launch saw.
  const models = useMemo(() => {
    if (availableModels && availableModels.length > 0) return availableModels;
    if (isNative) return [];
    return loadCachedAcpModels(agentType)?.availableModels ?? [];
  }, [availableModels, agentType, isNative]);

  // Every switchable agent with the models it can offer: the session's own
  // live list, and for the others what they advertised the last time they
  // were bound. Re-read on open (and after a refresh) — the cache is
  // localStorage, which nothing re-renders on.
  const pickerAgents = useMemo((): PickerAgent[] => {
    if (openGroup !== "model") return [];
    const ids = switchableAgents.includes(agentType)
      ? switchableAgents
      : [agentType, ...switchableAgents];
    return ids.map((a) => ({
      agentType: a,
      label: agentMeta(a).label,
      models: a === agentType ? models : (loadCachedAcpModels(a)?.availableModels ?? []),
    }));
  }, [openGroup, switchableAgents, agentType, models, refreshingModels]);

  const isClaude = agentType === "claude-code";
  const hasAcpModes = !!availableModes && availableModes.length > 0;
  const showMode = isClaude || hasAcpModes || modesPending;
  const toggle = (g: ComposerGroup) => {
    setOpenGroup((cur) => {
      if (cur === g) return null;
      if (cur) setDir(GROUP_ORDER.indexOf(g) > GROUP_ORDER.indexOf(cur) ? 1 : -1);
      // Mutual exclusion with the + menu — see atlas:composer-menu-open.
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "groups" }));
      return g;
    });
  };
  const close = () => setOpenGroup(null);

  const currentAcpMode = availableModes?.find((m) => m.id === currentMode);
  const currentModelInfo = models.find((m) => m.id === currentModel);

  // Labels stay visible on every pill — the reference folds unselected tabs
  // to icon-only, but on a toolbar whose pills are real controls that reads
  // worse than it looks (deliberately skipped).
  const pillCls = (active: boolean) =>
    cn(
      "flex items-center px-1.5 h-6.5 rounded-full border text-2xs leading-none font-medium transition-colors cursor-pointer",
      active
        ? "border-[var(--atlas-border-strong)] bg-[var(--atlas-element-selected)] text-[var(--foreground)]"
        : "border-[var(--border)] bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
    );

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      {/* Shared morphing panel — ONE container whose height tweens to the
          measured size of whatever group is showing (ResizeObserver on the
          content), so open/close AND group→group switches all animate through
          the same surface — the reference's shared-layout feel. */}
      <div
        aria-hidden={!openGroup}
        className={cn(
          // The app's own background (black, or white on a light theme) with
          // a hairline ring: the grey `popover` fill read as a slab under the
          // picker's tinted dividers.
          //
          // `transform-gpu`: the surface keeps its own compositing layer. The
          // welcome cards above the composer lift on hover with a translate,
          // which promotes THEM to a layer, and WebKit then painted that layer
          // over the part of this panel it overlapped — the search bar and the
          // fill vanished while the rows (painted later) stayed.
          "absolute bottom-full left-0 z-popover mb-1.5 transform-gpu overflow-hidden rounded-lg bg-background text-foreground shadow-md ring-1 ring-foreground/10",
          // The model group carries an agent rail beside its list, so it
          // takes more room; the width tweens with the height.
          openGroup === "model" ? "w-99" : "w-75",
        )}
        style={{
          height: openGroup ? panelHeight : 0,
          opacity: openGroup ? 1 : 0,
          pointerEvents: openGroup ? "auto" : "none",
          transition:
            "height 260ms cubic-bezier(0.32,0.72,0,1), width 260ms cubic-bezier(0.32,0.72,0,1), opacity 180ms ease-out",
        }}
      >
        <div ref={contentRef}>
          <div
            key={openGroup ?? "none"}
            className={cn(dir > 0 ? "atlas-group-slide-left" : "atlas-group-slide-right")}
          >
            {openGroup === "mode" && isClaude && (
              <div className="p-1">
                {CLAUDE_PERMISSION_MODES.map((m) => {
                  const active = m === permissionMode;
                  return (
                    <button
                      key={m}
                      onClick={() => {
                        setClaudePermissionMode(tabId, m);
                        close();
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                        active
                          ? "bg-[var(--atlas-element-selected)]"
                          : "hover:bg-[var(--atlas-element-hover)]",
                      )}
                    >
                      <span
                        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", claudeModeDotClass(m))}
                      />
                      <span className="flex-1 label">{CLAUDE_PERMISSION_MODE_LABEL[m]}</span>
                      {active && <Check size={11} className="text-[var(--primary)]" />}
                    </button>
                  );
                })}
              </div>
            )}

            {openGroup === "mode" && !isClaude && (
              <div className="p-1">
                {!hasAcpModes ? (
                  <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-[var(--muted-foreground)]">
                    <Loader2 size={11} className="animate-spin" /> Loading modes…
                  </div>
                ) : (
                  availableModes!.map((m) => {
                    const active = m.id === currentMode;
                    return (
                      <button
                        key={m.id}
                        onClick={() => {
                          setAcpMode(tabId, m.id);
                          close();
                        }}
                        className={cn(
                          "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                          active
                            ? "bg-[var(--atlas-element-selected)]"
                            : "hover:bg-[var(--atlas-element-hover)]",
                        )}
                      >
                        <span
                          className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: acpModeColor(m.id) }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 label">
                            {displayModeName(m.name)}
                            {active && <Check size={11} className="text-[var(--primary)]" />}
                          </span>
                          {m.description && (
                            <span className="mt-0.5 block text-3xs leading-snug text-[var(--muted-foreground)]">
                              {m.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {openGroup === "model" && (
              <ModelPicker
                agents={pickerAgents}
                currentAgent={agentType}
                currentModel={currentModel}
                onPick={(a, id) => {
                  if (a === agentType) {
                    if (id) setAcpModel(tabId, id);
                  } else {
                    onSwitchAgent(a as SwitchableAgent, id ?? undefined);
                  }
                  close();
                }}
                toolbar={(a) =>
                  a === "atlas-agent" && (
                    // The gateway's list, re-fetched on demand (ADR-0007).
                    // Same icon, spin and disabled idiom as the grant bar's
                    // Refresh — no new pattern.
                    <Hint label="Refresh models" side="top">
                      <button
                        type="button"
                        disabled={refreshingModels}
                        onClick={() => void refreshNativeModels()}
                        className={cn(
                          "shrink-0 rounded p-0.5 text-muted-foreground transition-colors",
                          refreshingModels
                            ? "cursor-default"
                            : "cursor-pointer hover:text-foreground",
                        )}
                      >
                        <RotateCw size={12} className={cn(refreshingModels && "animate-spin")} />
                      </button>
                    </Hint>
                  )
                }
                emptyState={(a) =>
                  // An empty native list is the gateway not having answered
                  // (ADR-0007), and the Refresh beside the search is the fix.
                  a === "atlas-agent" ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground">
                      No models
                      <span className="mt-0.5 block caption">
                        Couldn't load the model list. Check your connection or sign in, then
                        refresh.
                      </span>
                    </div>
                  ) : undefined
                }
                addView={
                  <div>
                    {/* Atlas ships no ACP agents (ADR-0002), so without this a
                        fresh profile's picker lists exactly one agent and reads
                        like Atlas supports one. */}
                    <FeaturedAgentOffers
                      onInstalled={(installed) => {
                        onSwitchAgent(installed as SwitchableAgent);
                        close();
                      }}
                    />
                    <div className="h-px bg-border-subtle" />
                    <button
                      onClick={() => {
                        close();
                        openSettingsSection("agents");
                      }}
                      className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
                    >
                      <Plus size={11} className="shrink-0" />
                      Add more agents
                    </button>
                  </div>
                }
              />
            )}
          </div>
        </div>
      </div>

      {/* Pill tab strip. One pill for the agent and its model: the agent's
          mark, then the model — or the agent's name while it has no model
          list to pick from. */}
      <button
        onClick={() => toggle("model")}
        className={pillCls(openGroup === "model")}
        title={
          cycleAgentHint
            ? `${agentMeta(currentAgent).label} — pick an agent and model here, ${cycleAgentHint} cycles agents`
            : `${agentMeta(currentAgent).label} — pick an agent and model`
        }
      >
        <AgentMark agentType={agentType} className="!h-4 !w-4 !text-3xs !rounded" />
        {/* `leading-normal` undoes the pill's `leading-none` here: `truncate`
            clips at the line box, and a one-em box cuts off descenders. */}
        <span
          className={cn(
            composerPillLabelClass(),
            "max-w-[96px] truncate leading-normal @[460px]:max-w-[140px]",
          )}
        >
          {currentModelInfo
            ? modelLabel(currentModelInfo)
            : currentModel
              ? capitalizeModelName(currentModel)
              : agentMeta(currentAgent).label}
        </span>
        <ChevronDown size={10} className="ml-0.5 shrink-0 text-[var(--muted-foreground)]" />
      </button>

      {showMode && (
        <button
          onClick={() => toggle("mode")}
          className={pillCls(openGroup === "mode")}
          title="Permission mode — pick here, ⇧⇥ cycles"
        >
          {isClaude ? (
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                claudeModeDotClass(permissionMode),
              )}
            />
          ) : (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: acpModeColor(currentMode) }}
            />
          )}
          <span className={composerPillLabelClass("late")}>
            {isClaude
              ? CLAUDE_PERMISSION_MODE_LABEL[permissionMode]
              : currentAcpMode
                ? displayModeName(currentAcpMode.name)
                : modesPending
                  ? "Loading…"
                  : "Mode"}
          </span>
        </button>
      )}
    </div>
  );
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
  const { setAcpModes, setAcpModesPending, setNativeEffort } = useChatStore.use.actions();
  // Show the picker as soon as the agent is non-Claude — even before its modes
  // load — so the composer can render a loading pill instead of nothing during
  // the agent spawn + new_session boot.
  const acpModesPending = useChatStore((s) => s.sessions[tabId]?.acpModesPending ?? false);
  // Self-heal the mode picker. chat-panel seeds the modes when a session is
  // first bound, but that path can be missed (resumed/restored sessions, an
  // effect that didn't re-run, etc.) — leaving a bound Codex session with the
  // modes sitting in Rust state but never pushed to the store, so no pill.
  // Since THIS component is what renders the pill, seed from here too: whenever
  // we're a bound non-Claude session with no modes loaded, pull the snapshot
  // and seed. Idempotent (bails once modes exist) and mirrors the codebase's
  // consumer-side self-heal pattern (file index / knowledge mentions).
  const seedBinding = useChatStore((s) => {
    const sess = s.sessions[tabId];
    if (!sess || sess.agentType === "claude-code") return null;
    if (!sess.acpAgentId || !sess.acpSessionId) return null;
    if ((sess.acpAvailableModes?.length ?? 0) > 0) return null;
    return `${sess.acpAgentId}::${sess.acpSessionId}`;
  });
  useEffect(() => {
    if (!seedBinding) return;
    const [agent_id, session_id] = seedBinding.split("::");
    let cancelled = false;
    void (async () => {
      try {
        const snap = await agents.snapshotMeta({ agent_id, session_id });
        if (!cancelled && snap.available_modes.length > 0) {
          setAcpModes(
            tabId,
            snap.current_mode,
            snap.available_modes,
            agentTypeFromPluginId(snap.plugin_id),
          );
        }
      } catch (err) {
        console.warn("seed ACP modes (composer self-heal) failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, seedBinding, setAcpModes]);
  // Safety net for a boot that HANGS (e.g. Codex's models-refresh waiting on a
  // child process that never answers): `new_session` neither resolves nor
  // rejects, so the create effect's `setAcpModesPending(false)` — which owns
  // settling this pill on every real outcome, success and failure alike —
  // never runs, and the picker would spin forever. This backstop must be
  // generous: a FIRST boot of a freshly installed agent legitimately takes
  // tens of seconds (adapter spawn + SDK init + the CLI's own first-run
  // setup), and a timer short enough to fire during it makes the composer
  // look ready while the agent is still starting. If the binding lands after
  // the backstop fires, the self-heal above still seeds the real modes.
  useEffect(() => {
    if (!acpModesPending) return;
    const t = setTimeout(() => setAcpModesPending(tabId, false), 120000);
    return () => clearTimeout(t);
  }, [tabId, acpModesPending, setAcpModesPending]);
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
  // Seed the reasoning-effort from the saved preference once per native session,
  // then re-push it whenever the session is bound (mirrors the model re-push).
  const nativeEffort = useChatStore((s) => s.sessions[tabId]?.nativeEffort);
  const nativeBound = useChatStore((s) => {
    const sess = s.sessions[tabId];
    return sess?.agentType === "atlas-agent" && !!sess.acpAgentId && !!sess.acpSessionId
      ? `${sess.acpAgentId}::${sess.acpSessionId}`
      : null;
  });
  useEffect(() => {
    if (agentType !== "atlas-agent") return;
    // Undefined = never set for this session → seed from the global pref.
    const eff = nativeEffort ?? loadNativeEffort();
    if (nativeBound || nativeEffort === undefined) setNativeEffort(tabId, eff);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, agentType, nativeBound]);
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
  const agentSlashCommands = useMemo<SlashCommand[]>(() => {
    // Every agent gets its advertised commands — the native agent included,
    // whose list the seam now publishes. Only the legacy "custom" placeholder
    // bails out.
    if (agentType === "custom") return [];
    const fromAgent: SlashCommand[] = (availableCommands ?? [])
      .map((c) => {
        const o = (c ?? {}) as {
          name?: string;
          description?: string;
          input?: { hint?: string } | null;
        };
        const name = (o.name ?? "").replace(/^\//, "");
        const hint = typeof o.input?.hint === "string" ? o.input.hint : null;
        return {
          name,
          signature: o.input != null ? `/${name} <${hint || "args"}>` : `/${name}`,
          description: o.description ?? "",
          handler: "passthrough" as const,
        };
      })
      .filter((c) => c.name && c.name !== "login");
    // `/login` is the ONE command Atlas synthesizes (S1). Everything else the
    // picker shows is passthrough from the agent's own `availableCommands` —
    // "we render what ACP gives, nothing else".
    //
    // Removed here, deliberately:
    //  - the per-agent `codex-login` / `atlas-login` handlers: every agent now
    //    routes through the same `AgentOAuthModal`, so the fork had no purpose
    //    beyond picking which of three dialogs to open;
    //  - the synthetic `/skills` row: Settings is not an agent command, and
    //    listing it here implied the agent understood it;
    //  - the dimmed `/clear` + `/logout` guard rows for Claude: the adapter
    //    blocklists them from `available_commands_update`, so showing rows that
    //    explain why an unadvertised command does nothing is Atlas inventing
    //    protocol surface. If an agent advertises them, they appear as
    //    passthrough like anything else.
    const login: SlashCommand | null = canSignIn(agentType)
      ? {
          name: "login",
          signature: "/login",
          description: `Sign in to ${agentMeta(agentType).label}.`,
          handler: "agent-login" as const,
        }
      : null;
    // The other Atlas-surface commands. Like /login, these drive app
    // affordances rather than the agent — a new tab, the send queue — so the
    // app is the honest place to synthesize them. /fork is gated on the same
    // capability as the header's "branch from here"; /queue exists for every
    // agent, because the queue does.
    const local: SlashCommand[] = [];
    if (agentCatalogEntry(agentType)?.supportsFork === true) {
      local.push({
        name: "fork",
        signature: "/fork",
        description: "Branch this conversation into a new tab",
        handler: "fork" as const,
      });
    }
    local.push({
      name: "queue",
      signature: "/queue <message>",
      description: "Queue a message to run when the agent is free",
      handler: "queue" as const,
    });
    return [...(login ? [login] : []), ...fromAgent, ...local];
  }, [agentType, availableCommands]);
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

  // The editor chunk started downloading at module-eval time (see the top of this
  // file). Mirror the resolution into component state so React re-renders
  // once the component class is available. We never render a textarea
  // fallback — instead the placeholder div below holds the layout slot at
  // the same height so the swap is invisible (no reflow, no mount/unmount
  // of an interactive element mid-typing).
  const [LazyChatInput, setLazyChatInput] = useState<typeof ChatInputComponent | null>(null);
  const [LazyMentionPicker, setLazyMentionPicker] = useState<typeof MentionPickerComponent | null>(
    null,
  );
  const [LazySlashPicker, setLazySlashPicker] = useState<typeof SlashCommandPickerComponent | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void chatInputPromise.then((m) => {
      if (!cancelled) setLazyChatInput(() => m.ChatInput);
    });
    void mentionPickerPromise.then((m) => {
      if (!cancelled) setLazyMentionPicker(() => m.MentionPicker);
    });
    void slashCommandPickerPromise.then((m) => {
      if (!cancelled) setLazySlashPicker(() => m.SlashCommandPicker);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  /** The agent's own words from the last auth failure, so a later `/login`
   *  can pass them along — the modal uses `reason` to tell "wants a provider
   *  key" from "not signed in". */
  const lastAuthReasonRef = useRef<string | null>(null);

  // An auth-classified turn failure routes to the sign-in flow (P15) instead of
  // dying as a generic banner. Every agent lands on the SAME modal now (S2):
  // Claude no longer forks to its setup dialog and Codex no longer to a pill,
  // because `AgentOAuthModal` renders whatever methods the agent advertises.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; agentType?: string; reason?: string }>)
        .detail;
      const at = detail?.agentType;
      if (!at) return;
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess?.acpSessionId || sess.acpSessionId !== detail.sessionId) return;
      lastAuthReasonRef.current = detail.reason ?? null;
      if (canSignIn(at)) promptSignIn(at, { reason: detail.reason });
    };
    window.addEventListener("atlas:auth-required", handler);
    return () => window.removeEventListener("atlas:auth-required", handler);
  }, [tabId]);

  // Picking a project or repo attaches it to the session, read-only, so its
  // chip can offer the access toggle before the send. A session that has not
  // bound yet attaches it at the send instead (`attach-mentioned-projects.ts`).
  // A refused folder (home, a system folder) says why at the send, not here.
  const attachPicked = useCallback(
    (mention: MentionData, source: AttachSource = "mention") => {
      if (mention.kind !== "workspace" && mention.kind !== "repo") return;
      const sessionId = useChatStore.getState().sessions[tabId]?.acpSessionId;
      if (!sessionId) return;
      attachSessionProject(sessionId, mention.absPath, {
        displayName: mention.displayName,
        source,
      })
        .then((change) =>
          useSessionProjectsStore.getState().actions.replace(sessionId, change.projects),
        )
        .catch(() => {});
    },
    [tabId],
  );

  const handleMentionSelect = useCallback(
    (mention: MentionData) => {
      const t = triggerRef.current;
      if (!t) return;
      inputRef.current?.insertMention(mention, { from: t.from, to: t.to });
      attachPicked(mention);
      // Trigger naturally closes when the doc no longer has an `@…` before
      // the caret; the plugin will fire the null transition for us.
    },
    [attachPicked],
  );

  // ── File chips ──────────────────────────────────────────────────────────
  // A path the agent reads off disk, as a chip at the caret. Every file with
  // a path arrives through `attachPaths` (below), which calls this for all of
  // them; an image the agent can take also stages its bytes.
  const composerRef = useRef<HTMLDivElement>(null);
  const insertFileChips = useCallback(
    (paths: string[], sizes?: ReadonlyMap<string, number>) => {
      const root = projectPath && !projectPath.endsWith("/") ? `${projectPath}/` : projectPath;
      for (const abs of paths) {
        // Relative-to-project display name when the file lives inside the
        // project; otherwise just the basename (dropped files can be anywhere).
        const displayName =
          root && abs.startsWith(root) ? abs.slice(root.length) : abs.split("/").pop() || abs;
        const mention: MentionFile = {
          kind: "file",
          id: abs,
          displayName,
          absPath: abs,
        };
        inputRef.current?.insertMention(mention, { sizeBytes: sizes?.get(abs) });
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [projectPath],
  );
  // ── Image attachments (multimodal input) ─────────────────────────────────
  // Images staged for the next send. Only populated when the bound agent
  // advertised promptCapabilities.image; otherwise picked images degrade to
  // path mention chips (any agent can read those off disk).
  //
  // A staged image shows only as its chip in the prompt — no thumbnail strip
  // above the field, which repeated what the chip already says. The chip and
  // the staged bytes are one attachment, joined by `path`: deleting the chip
  // drops the bytes (`handleDocChange`). The agent gets both the inline bytes
  // (downscaled if over budget) and the path, which it can open at full size.
  // The sent message still shows the images (`transcript-rows.tsx`).
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const stagedRef = useRef(stagedImages);
  stagedRef.current = stagedImages;
  // Non-null (the repo's full_name) while a GitHub repo is cloning into
  // `.atlas/repos`. The composer is locked for the duration so the user can't
  // send a prompt that references a half-synced repo.
  const [githubSyncing, setGithubSyncing] = useState<string | null>(null);
  const acpBoundKey = useChatStore((s) => {
    const sess = s.sessions[tabId];
    return sess?.acpAgentId && sess.acpSessionId
      ? `${sess.acpAgentId}::${sess.acpSessionId}`
      : null;
  });
  const [imageSupported, setImageSupported] = useState(false);
  useEffect(() => {
    if (!acpBoundKey) {
      setImageSupported(false);
      return;
    }
    const [agent_id, session_id] = acpBoundKey.split("::");
    let cancelled = false;
    agents
      .snapshotMeta({ agent_id, session_id })
      .then((snap) => {
        if (!cancelled) setImageSupported(!!snap.prompt_image_supported);
      })
      .catch(() => {
        if (!cancelled) setImageSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [acpBoundKey]);
  // Rebinding to an agent without image support (agent switch, crash rebind)
  // drops staged images — they could no longer be sent truthfully.
  useEffect(() => {
    if (!imageSupported) setStagedImages([]);
  }, [imageSupported]);

  // The per-image budget is per image only: several in-budget attachments
  // plus the prompt, tools and history can still blow the gateway's body cap
  // (#71). The gateway's 413 stays the backstop — this is the warning the
  // user is owed BEFORE pressing send, once per crossing, cleared when they
  // remove enough to fit again.
  const stagedOverAggregateBudget = aggregateExceedsBudget(
    stagedImages.map((img) => img.dataBase64.length),
  );
  const warnedAggregateRef = useRef(false);
  useEffect(() => {
    if (stagedOverAggregateBudget && !warnedAggregateRef.current) {
      warnedAggregateRef.current = true;
      toast.warning(
        "These attachments together are near the 2 MB request limit — the send may be refused. Consider removing one.",
      );
    }
    if (!stagedOverAggregateBudget) warnedAggregateRef.current = false;
  }, [stagedOverAggregateBudget]);

  // ── Attaching files by path ──────────────────────────────────────────────
  // The one routing rule for every way a file arrives — dropped from Finder,
  // picked in the "+" menu, copied in Finder and pasted, a pasted screenshot
  // (spooled to a file first, `handlePasteImages`), the screenshot tool:
  // every file becomes a chip at the caret, and an image the agent can take
  // is staged inline as well, behind its chip. One routing
  // for all of them, because the ways used to disagree: a paste staged a
  // thumbnail and left nothing in the sentence, so "look at [this]" had no
  // "this" in it; a drop made a chip and no thumbnail; and before that a
  // dropped screenshot reached the agent as a path it might never open while
  // the same image pasted arrived inline.
  const attachPaths = useCallback(
    async (paths: string[]) => {
      const images: StagedImage[] = [];
      const sizes = new Map<string, number>();
      for (const p of paths) {
        const mime = imageSupported ? imageMimeFromPath(p) : null;
        if (!mime) continue;
        try {
          const data = await invoke<string>("read_file_base64", { path: p });
          // The file's size, from the base64 it came as (the padding makes
          // this at most two bytes over).
          sizes.set(p, Math.floor((data.length * 3) / 4));
          images.push({
            ...(await downscaleAttachment({ mimeType: mime, dataBase64: data })),
            path: p,
          });
        } catch {
          // Unreadable as base64: the chip alone, as for any other file.
        }
      }
      if (images.length) setStagedImages((prev) => [...prev, ...images]);
      insertFileChips(paths, sizes);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [imageSupported, insertFileChips],
  );

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
  const [composerFocused, setComposerFocused] = useState(false);
  const collapsible =
    !hasText &&
    stagedImages.length === 0 &&
    queue.length === 0 &&
    trigger === null &&
    !slashOpen &&
    githubSyncing === null &&
    !isDropTarget;
  const collapsed = collapsible && !composerFocused;
  const inputCardRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const trayShown = useComposerFold(collapsed, inputCardRef, trayRef);
  // What folds it: focus moving to something ELSE (Tab away), a press
  // outside it, or Esc. Not focus merely leaving: WebKit does not focus a
  // button on click, so pressing a tray pill drops focus to <body> — read as
  // "left", that folded the tray out from under the pill being pressed.
  // Never while one of its menus is open (they may live in a portal), nor
  // when the WINDOW lost focus (switching apps is not leaving the composer).
  const composerMenuOpen = () =>
    !!composerRef.current?.querySelector("[data-popup-open], [aria-expanded='true']");
  const onComposerBlur = useCallback(() => {
    requestAnimationFrame(() => {
      if (!document.hasFocus()) return;
      const root = composerRef.current;
      const active = document.activeElement;
      if (!root || !active || active === document.body) return;
      if (root.contains(active) || composerMenuOpen()) return;
      setComposerFocused(false);
    });
  }, []);
  useEffect(() => {
    if (!composerFocused) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = composerRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      if (composerMenuOpen()) return;
      setComposerFocused(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [composerFocused]);

  // "+" menu → "Add files or photos". The Tauri dialog hands back real
  // paths (a browser file input wouldn't), which is what makes the
  // `attachPaths` routing possible.
  const pickFilesOrPhotos = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        title: "Attach files or photos",
      });
      if (!picked) return;
      await attachPaths((Array.isArray(picked) ? picked : [picked]) as string[]);
    } catch (err) {
      console.warn("attach picker failed:", err);
    }
  }, [attachPaths]);

  const handlePickProject = useCallback(
    (project: MentionProject) => {
      inputRef.current?.insertMention(project);
      attachPicked(project);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [attachPicked],
  );

  // "+" menu → "Attach media". The files picker, with the OS dialog filtered
  // to image/video extensions; video becomes a path chip via `attachPaths`.
  const pickMedia = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        title: "Attach media",
        filters: [
          {
            name: "Media",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "heic",
              "bmp",
              "svg",
              "mp4",
              "mov",
              "webm",
              "m4v",
              "avi",
              "mkv",
            ],
          },
        ],
      });
      if (!picked) return;
      await attachPaths((Array.isArray(picked) ? picked : [picked]) as string[]);
    } catch (err) {
      console.warn("media picker failed:", err);
    }
  }, [attachPaths]);

  // "+" menu → "Take a screenshot". Shells out to the native macOS
  // `screencapture` CLI (region selection or whole desktop), then attaches the
  // saved `.atlas/screenshots/…` PNG like any other file (`attachPaths`).
  const handleTakeScreenshot = useCallback(
    async (mode: "region" | "full") => {
      try {
        // Let the "+" menu fully close first so it (and any dropdown) isn't caught
        // in a whole-desktop capture.
        await new Promise((r) => setTimeout(r, 250));
        const proj = useAppStore.getState().currentProject?.path ?? null;
        const res = await invoke<{ path: string } | null>("capture_screenshot", {
          mode,
          projectPath: proj,
        });
        if (!res) return; // cancelled (Esc during region select)
        await attachPaths([res.path]);
      } catch (err) {
        toast.error(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [attachPaths],
  );

  // "+" menu → "Add from GitHub". Shorthand for the GitHub panel's search+clone:
  // download the repo into `<project>/.atlas/repos`, lock the composer while it
  // syncs, then drop a `@repo:` chip carrying the local path so the agent
  // explores it (compose_prompt turns that chip into an "explore this repo"
  // block pointing at the absolute path).
  const handleCloneRepo = useCallback(
    async (repo: GithubRepo) => {
      const proj = useAppStore.getState().currentProject?.path;
      if (!proj) {
        toast.error("Open a project before cloning a repo.");
        return;
      }
      setGithubSyncing(repo.full_name);
      try {
        const dest = await invoke<string>("clone_github_repo", {
          projectPath: proj,
          cloneUrl: repo.clone_url,
          repoName: repo.full_name.replace(/\//g, "-"),
          meta: metaFromSearch(repo),
        });
        const folderName = dest.split("/").pop() || repo.full_name.replace(/\//g, "-");
        const mention: MentionRepo = {
          kind: "repo",
          id: dest,
          displayName: folderName,
          absPath: dest,
          hasReadme: false,
        };
        inputRef.current?.insertMention(mention);
        attachPicked(mention, "clone");
        // Keep the knowledge sidebar's cloned-repos list in sync (same signal the
        // GitHub panel emits).
        window.dispatchEvent(new Event("atlas:repo-cloned"));
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (err) {
        toast.error(
          `Couldn't clone ${repo.full_name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setGithubSyncing(null);
      }
    },
    [attachPicked],
  );

  // "+" menu → "Attach a session". Reference a past session's transcript; the
  // (potentially large) body is read + formatted at send time by composePrompt.
  const handlePickSession = useCallback((session: PastSessionRef) => {
    const mention: MentionPastSession = {
      kind: "past_session",
      id: session.id,
      displayName: session.title,
      sessionId: session.id,
      sessionTitle: session.title,
      cwd: session.cwd,
    };
    inputRef.current?.insertMention(mention);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // "+" menu footer → agent switcher. Same helper as ⌥/ and the agent pill,
  // but jumps straight to the picked agent instead of cycling.
  const handleSwitchAgent = useCallback(
    (next: SwitchableAgent, model?: string) => switchAgentForTab(tabId, next, { model }),
    [tabId],
  );

  // Clipboard images (screenshots). A pasted screenshot is bytes with no
  // path, so it is spooled to a scratch file first and then attached like
  // every other file (`attachPaths`): a chip in the sentence, with its bytes
  // staged when the agent takes images. Taking the paste either way matters —
  // declining it left the paste to a handler that only knows Finder paths,
  // and the image vanished without a word.
  const handlePasteImages = useCallback(
    (files: File[]) => {
      void Promise.all(files.map(scratchPathForFile))
        .then(attachPaths)
        .catch((err) => {
          console.warn("image paste failed:", err);
          toast.error("Could not attach the pasted image.");
        });
      return true;
    },
    [attachPaths],
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

  // A paste over the large-paste limit (`isLargePaste`: ~4,000 characters or
  // 80 lines) — a log, a stack dump, a whole file — becomes a chip holding
  // the whole text, so the editor never lays it out. The text goes to the
  // agent in full at send, in whichever form it accepts (`pasted-text.ts`).
  const handlePasteLargeText = useCallback((text: string) => {
    const input = inputRef.current;
    if (!input) return false;
    input.insertMention(pastedTextMention(text));
    return true;
  }, []);

  // `submit` (below) is defined after `handleSlashSelect` but the latter
  // needs to invoke it — routed through a ref (set right after `submit` is
  // declared) rather than a direct reference, since a `useCallback` deps
  // array is evaluated eagerly on every render and would otherwise read
  // `submit` before its `const` initializes.
  const submitRef = useRef<() => void>(() => {});

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      const t = slashStore.get();
      const input = inputRef.current;
      if (!t || !input) return;
      // An Atlas-local command leaves no literal `/login` behind.
      const clearSlashRange = () => input.replaceRange(t.from, t.to, "");

      if (cmd.handler === "agent-login") {
        // An Atlas-handled command (S1): every agent opens the same
        // `AgentOAuthModal`. `reason` is passed so the modal can tell an
        // "agent wants a provider key" failure from a plain "not signed in".
        clearSlashRange();
        setSlashTrigger(null);
        promptSignIn(agentType, { reason: lastAuthReasonRef.current ?? undefined });
        inputRef.current?.focus();
        return;
      }
      if (cmd.handler === "fork") {
        // Same flow as the header's "branch from here" menu item.
        clearSlashRange();
        setSlashTrigger(null);
        forkSessionToNewTab(tabId);
        inputRef.current?.focus();
        return;
      }
      // "queue" needs a message, so its signature carries `<message>` and the
      // requires-args branch below inserts "/queue " for the user to fill in;
      // the actual queueing happens in `submit`, which intercepts the typed
      // form.

      // Passthrough: every other command is sent verbatim to the agent.
      // claude-agent-acp's SDK processes the slash command client-side
      // and emits the result as `<local-command-*>` blocks via the
      // normal `agent_message_chunk` channel, so the response renders in
      // the chat thread alongside regular assistant output.
      //
      // Gate on `disabled` — passthrough requires a working ACP
      // connection, and sending a slash command to a not-yet-authed
      // agent would just surface an error. `/login` bypasses this gate
      // above because it's the path that fixes "not authed".
      if (disabled) {
        clearSlashRange();
        setSlashTrigger(null);
        return;
      }
      if (commandRequiresArgs(cmd)) {
        // Drop `/<name> ` into the composer and put the caret at the
        // end so the user can fill in the required args. Don't send
        // until they press Enter.
        input.replaceRange(t.from, t.to, `/${cmd.name} `);
        setSlashTrigger(null);
        input.focus();
        return;
      }

      // No required args — commit the full command name in place of the
      // typed token (the query may be a prefix, e.g. "he" → "help"). Since
      // the trigger can sit mid-message, replacing just [from, to] preserves
      // any surrounding text instead of wiping the whole composer.
      input.replaceRange(t.from, t.to, `/${cmd.name}`);
      setSlashTrigger(null);
      if (!t.atStart) {
        // Mid-message: complete the text and stop. Only a command at byte 0
        // resolves — auto-sending from here would ship `/foo` to the agent as
        // prose and silently do nothing. Leaving it in the composer matches
        // the mention picker (Enter selects, it doesn't send) and keeps the
        // user's next Enter meaningful.
        inputRef.current?.focus();
        return;
      }
      // At byte 0 the command will actually run, so fall through to the normal
      // submit path — trim/mentions/queueing behave exactly like a typed Enter.
      submitRef.current();
    },
    [disabled, agentType, tabId],
  );

  // Forward Up/Down/Enter/Esc/Backspace/Tab from the editor to whichever
  // picker is open. Slash and mention pickers are mutually exclusive in
  // practice (each trigger requires its own sigil to open the token being
  // typed), but we still route deterministically.
  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape" | "Backspace" | "Tab") => {
      // Slash takes precedence when both happen to be open.
      const sp = slashPickerRef.current;
      const st = slashStore.get();
      if (st && sp) {
        switch (key) {
          case "Up":
            sp.moveUp();
            return true;
          case "Down":
            sp.moveDown();
            return true;
          case "Enter":
            return sp.commit();
          case "Escape":
            setSlashTrigger(null);
            return true;
          case "Backspace":
            // Let the editor delete a query char or the `/` itself (which closes
            // the picker via the trigger detector).
            return false;
          case "Tab": {
            const active = sp.activeCommand();
            if (!active) return true;
            // Only real passthrough commands get "complete without sending"
            // — that's for filling in args before Enter. Host-handled rows
            // (login, open-settings, unavailable guards) take no args, so
            // completing them into plain text would let a guard row like
            // dimmed `/clear` slip past its own handler on the next Enter
            // and get sent to the agent as literal passthrough text — the
            // exact silent no-op these guard rows exist to prevent. Those
            // run through the normal commit path instead, same as Enter.
            if (active.handler !== "passthrough") {
              return sp.commit();
            }
            // Complete to the full command name (never sends). The caret
            // lands right after a trailing space, which the trigger
            // detector reads as "hit whitespace" and closes the picker on
            // its own — same as if the user had typed the space by hand.
            inputRef.current?.replaceRange(st.from, st.to, `/${active.name} `);
            return true;
          }
        }
      }

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
          // At a sublevel, Esc pops back. At the top level, it closes.
          if (p.goBack()) return true;
          setTrigger(null);
          return true;
        case "Backspace":
          // Only consume Backspace when at a sublevel AND the query is
          // empty — otherwise let the editor delete a character in the query (or
          // the `@` itself, which closes the picker via the trigger
          // detector).
          if (t.query === "" && p.goBack()) return true;
          return false;
        case "Tab":
          // Not handled for the mention picker — fall through to the
          // composer's Tab (list indent / outdent).
          return false;
      }
    },
    [],
  );

  // Auto-focus the composer whenever this panel mounts (tab switch back into
  // chat). If the editor chunk hasn't resolved yet, the next re-render
  // (driven by `LazyChatInput` flipping non-null) re-runs this effect and
  // focuses the real input as soon as it exists.
  useEffect(() => {
    if (!LazyChatInput) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [tabId, LazyChatInput]);

  // Listen for "Reply" clicks on message items — prepend a quote block.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content: string }>).detail;
      if (!detail?.content) return;
      const quoted = detail.content
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const cur = inputRef.current?.getValue() ?? valueRef.current;
      writeComposer(`${quoted}\n\n${cur}`);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-reply", handler);
    return () => window.removeEventListener("atlas:chat-reply", handler);
  }, [writeComposer, valueRef]);

  // Prefill the composer with raw text (empty-state prompt chips, a user row's
  // "Edit as new message"). Unlike "reply" this replaces the value verbatim (no
  // quote block) and focuses. Tab-scoped like `atlas:chat-send`: a tabId-less
  // event still reaches every mounted composer.
  //
  // Replacing is destructive, so a non-empty draft that differs from the new
  // text is offered back through an Undo toast rather than silently dropped.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; tabId?: string }>).detail;
      if (!detail?.text) return;
      if (detail.tabId != null && detail.tabId !== tabId) return;
      const previous = inputRef.current?.getValue() ?? valueRef.current;
      writeComposer(detail.text);
      requestAnimationFrame(() => inputRef.current?.focus());
      if (previous.trim() && previous !== detail.text) {
        toast("Replaced your draft", {
          action: {
            label: "Undo",
            onClick: () => {
              writeComposer(previous);
              requestAnimationFrame(() => inputRef.current?.focus());
            },
          },
        });
      }
    };
    window.addEventListener("atlas:chat-prefill", handler);
    return () => window.removeEventListener("atlas:chat-prefill", handler);
  }, [tabId, writeComposer, valueRef]);

  // Focus the composer on demand. The sidebar "+ new chat" button fires this
  // when it reuses an already-empty tab: no remount happens in that case, so
  // the mount auto-focus above doesn't re-run. Tab-scoped so only the active
  // composer grabs focus (the event fans out to every mounted chat tab).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId && detail.tabId !== tabId) return;
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-focus", handler);
    return () => window.removeEventListener("atlas:chat-focus", handler);
  }, [tabId]);

  // Append text to the composer (e.g. the KB bubble menu's "Send selection to
  // chat"). Unlike "prefill" this is NON-destructive (keeps any draft) and only
  // the ACTIVE session reacts, so it doesn't fan out to every mounted chat tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ChatInsertDetail>).detail;
      if (!detail?.text) return;
      if (detail.tabId ? detail.tabId !== tabId : useChatStore.getState().activeSessionId !== tabId)
        return;
      const cur = inputRef.current?.getValue() ?? valueRef.current;
      writeComposer(insertedDraft(cur, detail));
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-insert", handler);
    return () => window.removeEventListener("atlas:chat-insert", handler);
  }, [tabId, writeComposer, valueRef]);

  // A comment popover's link button (this tab's own recorded session's
  // comment) or a reply passage's Cite, as a chip at the caret. Linking one
  // already in the draft just focuses — the agent needs to be pointed at it
  // once.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CommentLinkDetail>).detail;
      if (!detail || detail.tabId !== tabId || disabled) return;
      const input = inputRef.current;
      if (!input) return;
      const linked = input
        .getMentions()
        .some((m) => m.kind === detail.mention.kind && m.id === detail.mention.id);
      if (!linked) input.insertMention(detail.mention, { padBefore: true });
      // Handled: the cite popover closes only on this (`linkCiteToComposer`).
      e.preventDefault();
      // Now, not after the debounce: the diff draws a review comment back
      // from the draft (`useComposerReviewComments`).
      if (detail.mention.kind === "review_comment") flushDraft();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(COMMENT_LINK_EVENT, handler);
    return () => window.removeEventListener(COMMENT_LINK_EVENT, handler);
  }, [tabId, disabled, flushDraft]);

  // A review comment deleted where it was written (its annotation in the
  // diff or the file view): its chip leaves the prompt too.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ReviewUnlinkDetail>).detail;
      if (!detail || detail.tabId !== tabId) return;
      const input = inputRef.current;
      if (!input) return;
      input.removeMention("review_comment", detail.id);
      e.preventDefault();
      flushDraft();
    };
    window.addEventListener(REVIEW_UNLINK_EVENT, handler);
    return () => window.removeEventListener(REVIEW_UNLINK_EVENT, handler);
  }, [tabId, flushDraft]);

  // An agent switch with `agentSwitchBehavior: "handoff"`: the conversation
  // the tab just left, as a past-session chip at the start of the draft, so
  // the next message carries it to the new agent (`switch-agent.ts`).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SessionHandoffDetail>).detail;
      if (!detail || detail.tabId !== tabId) return;
      const input = inputRef.current;
      if (!input) return;
      const attached = input
        .getMentions()
        .some((m) => m.kind === "past_session" && m.id === detail.mention.id);
      if (!attached) input.insertMention(detail.mention, { atStart: true });
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(SESSION_HANDOFF_EVENT, handler);
    return () => window.removeEventListener(SESSION_HANDOFF_EVENT, handler);
  }, [tabId]);

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
          <div className="mb-2 flex flex-col gap-1">
            <div className="text-2xs uppercase tracking-wider text-[var(--muted-foreground)] px-1">
              Queued · {queue.length}
              {/* The owner's queued prompts wait while someone else drives
                  (R4): Rust's drain skips them until the seat is back. */}
              {remoteDriving && " · runs when you take over"}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {queue.map((q, i) => (
                <QueueChip
                  key={i}
                  text={q}
                  onEdit={() => {
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
                  onRemove={() => removeQueuedPrompt(tabId, i)}
                />
              ))}
            </div>
          </div>
        )}

        {/* The turn the computer slept through, while it is still going. */}
        <SleepPill tabId={tabId} />
        {/* Transient-failure retry countdown (native agent). */}
        <RetryPill tabId={tabId} />

        {/* The no-grant setup state (D15a), tucked into the top of the
            composer — the explanation for the input being locked below.
            Scoped to the native agent for the same reason the lock is: the
            other agents do not use the Atlas gateway, so an org with no grant
            is not their problem and a bar over a working composer is noise.
            Deferred while a turn runs, with the lock (`grantLocksComposer`). */}
        {agentType === "atlas-agent" && <AiGrantBar turnRunning={running} />}

        {/* The tab's agent was uninstalled — same strip, same reason: the
            input below cannot send until the chat is switched. */}
        {!grantBarShown && <RemovedAgentBar tabId={tabId} />}

        {/* A resume could not restore the user's mode: nothing sends until
            they pick one. */}
        {!grantBarShown && <ModeRestoreBar tabId={tabId} />}

        {/* The last turn moved the checkout to another branch: the next
            message would run there. */}
        {!grantBarShown && <BranchChangedBar tabId={tabId} />}

        {/* Another process is writing this session: sending would fork it. */}
        {!grantBarShown && <LiveElsewhereBar tabId={tabId} />}

        {/* Someone else holds the remote-control seat, or asks for it. */}
        {!grantBarShown && <RcDriverBar tabId={tabId} />}

        {/* Live plan docked on top of the input bar (JetBrains-Air style). */}

        <div
          ref={composerRef}
          data-chat-composer
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
          {githubSyncing !== null && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--background)]/40 backdrop-blur-[1px]">
              <span className="flex items-center gap-2 rounded-full bg-[var(--card)] px-3 py-1 text-xs font-medium text-[var(--secondary-foreground)] shadow">
                <Loader2 size={12} className="animate-spin" />
                Syncing {githubSyncing}…
              </span>
            </div>
          )}
          {dropZoneEl &&
            createPortal(
              // In with no transition: this is direct feedback to the pointer
              // crossing into the zone, and any fade reads as lag behind the
              // hand. Out over `duration-instant`, so it doesn't vanish in the
              // same frame the dropped attachment appears. Always mounted
              // (toggled by `data-active`) so the exit can transition at all.
              // Opacity only; nothing travels, so reduced motion needs no variant.
              // `z-40` clears the composer's own `z-30` in the same stacking
              // context; a named layer would escape the column and cover toasts.
              <div
                aria-hidden="true"
                data-active={isDropTarget}
                className={cn(
                  "pointer-events-none absolute inset-2 z-40 flex items-center justify-center",
                  // The scrim dims the thread behind: the label must read as the one
                  // live layer, not float among the welcome tiles.
                  "rounded-xl border border-dashed border-[var(--primary)] bg-[var(--background)]/80",
                  "opacity-0 transition-opacity duration-instant ease-out-strong",
                  "data-[active=true]:opacity-100 data-[active=true]:duration-0",
                )}
              >
                <div className="flex flex-col items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 shadow-md">
                  <AtSign size={16} className="text-[var(--primary)]" />
                  <span className="text-sm font-medium text-[var(--foreground)]">
                    Drop to reference
                  </span>
                  {/* Says what will happen, because the two gestures now differ:
                      a drop writes a chip into the sentence, the "+" menu
                      attaches. */}
                  <span className="text-xs text-[var(--muted-foreground)]">
                    Added as an @mention in your message
                  </span>
                </div>
              </div>,
              dropZoneEl,
            )}
          {/* Inner input surface — nested card with its own border + focus
              glow, sitting proud of the muted shell. The send button lives INSIDE it. */}
          <div
            ref={inputCardRef}
            className={cn(
              // `min-h-[44px]`: the send button is absolutely positioned 8px
              // from the top at 28px tall, so it needs 36px of field to sit
              // inside. The editor's own min-height (`.atlas-chat-composer`
              // in globals.css) normally provides it; the floor makes the
              // geometry hold before the editor chunk has landed, or with no
              // editor mounted at all.
              // `z-10` so the tray slides up BEHIND it. A capsule while the
              // composer is folded (`rounded-composer`: half the card's 46px),
              // a card while it is open; the corner eases between the two.
              // No bottom margin: the tray hangs straight off its edge.
              // `shadow-sm`: the `md` rung cast onto the tray under it and read
              // as the tray being disabled.
              "relative z-10 mx-1 mt-1 min-h-[44px] border border-[var(--border)] bg-[var(--background)] shadow-sm",
              collapsed ? "rounded-composer" : "rounded-xl",
              "transition-[border-radius,border-color,box-shadow] duration-base ease-out-strong motion-reduce:transition-none",
              // Focus treatment at HALF strength: the full border-focus +
              // /20 accent ring read far too loud on the nested surface.
              "focus-within:border-[color-mix(in_srgb,var(--atlas-border-strong)_50%,var(--border))]",
              "focus-within:ring-1 focus-within:ring-[var(--primary)]/10",
              // The disabled dim, scoped to the field the lock actually
              // applies to (see the shell above). No red tint — the send
              // button is already disabled and submit()/Cmd+Enter are gated
              // on `disabled`.
              disabled && "opacity-60",
            )}
          >
            {/* Only the text area is pointer-blocked while `disabled`:
              `pointer-events-none` stops click-to-focus/typing AND the focus
              event, so we never trigger the agent-bind listener against a CLI
              that isn't ready. The toolbar below stays live so the agent /
              model pickers remain reachable. */}
            {/* px padding (not rem — see the send button's geometry note):
                clears the 28px button + 8px inset at any UI scale. */}
            <div className={cn("pr-[40px]", disabled && "pointer-events-none")}>
              {LazyChatInput ? (
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
              )}
            </div>
            {/* No wrapping span: it would sit in flow and misplace this absolute button. */}
            <Hint
              side="top"
              wrap={false}
              label={
                mode === "stop"
                  ? stopping
                    ? "Stopping… (waiting for the agent to wind down)"
                    : "Stop generation"
                  : mode === "queue"
                    ? "Queue message (sends after current finishes)"
                    : "Send to agent"
              }
              shortcut={mode === "send" ? (enterToSend ? "↵" : "⌘↵") : undefined}
            >
              <button
                onClick={submit}
                disabled={!buttonEnabled}
                aria-label={
                  mode === "stop"
                    ? "Stop generation"
                    : mode === "queue"
                      ? "Queue message"
                      : "Send message"
                }
                className={cn(
                  // Reference-style squircle send: a soft rounded-square,
                  // transparent at rest, muted fill + border on hover, pinned
                  // top-right of the input surface (it does not ride down as
                  // the field grows).
                  // Geometry IN PX, not rem: Atlas's UI-scale setting shrinks
                  // the root font-size, so rem utilities (w-7/top-2 → 23px/6.5px
                  // under scale) drift against the editor's hardcoded 12px/16px
                  // padding — the ruler-measured misalignment. The first text
                  // line centers at 12px pad + ~10px half-line = 22px; a 28px
                  // button at 8px top centers at 22px at EVERY UI scale.
                  "absolute top-[8px] right-[8px] flex items-center justify-center w-[28px] h-[28px] rounded-lg border transition-colors",
                  buttonEnabled
                    ? "border-transparent text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] hover:border-[var(--border)] cursor-pointer"
                    : "border-transparent text-[var(--muted-foreground)] cursor-not-allowed",
                )}
              >
                {/* Updates in place: Enter sends, so the arrow↔stop swap is
                    keyboard-driven and has no animation. */}
                <span className="flex items-center justify-center">
                  {mode === "stop" ? (
                    <Square
                      size={11}
                      strokeWidth={3}
                      fill="currentColor"
                      className={stopping ? "animate-pulse" : undefined}
                    />
                  ) : (
                    <ArrowUp size={15} strokeWidth={2.5} />
                  )}
                </span>
              </button>
            </Hint>
          </div>
          {/* The toolbar tray, tucked under the input card. Folding, the card
              slides down over it while it fades, so the two read as one bar
              retracting into the input; opening runs it back. Transform and
              opacity only, and the tray leaves the layout once, when the fold
              lands — never a height tween, which resized the transcript above
              every frame (`use-composer-fold.ts`). Pill labels collapse to
              icons as the shell narrows (`composerPillLabelClass`), so the row
              never wraps or runs past the edge. */}
          <div ref={trayRef} hidden={!trayShown}>
            <div
              inert={collapsed}
              // Fill: the panel-input background (near-black on the default
              // dark theme), a shade off the input card above, not a full step.
              className="mx-5 flex items-center justify-between gap-2 rounded-b-xl border border-t-0 border-[var(--border)] bg-[var(--atlas-panel-input-background)] px-2 pb-1.5 pt-2"
            >
              <div className="flex min-w-0 items-center gap-1">
                <ComposerAddMenu
                  // `disabledProp`, NOT `disabled`: a missing org AI grant locks
                  // the input, not the toolbar. Greying the + here made the whole
                  // footer read as dead while the fix (switch agent, request a
                  // grant) is one row away.
                  disabled={disabledProp || githubSyncing !== null}
                  projectPath={useAppStore.getState().currentProject?.path ?? null}
                  agentId={switchableAgent}
                  imageSupported={imageSupported}
                  onAddFilesOrPhotos={() => void pickFilesOrPhotos()}
                  onAttachMedia={() => void pickMedia()}
                  onTakeScreenshot={(mode) => void handleTakeScreenshot(mode)}
                  onCloneRepo={(repo) => void handleCloneRepo(repo)}
                  onPickSession={handlePickSession}
                  onPickProject={handlePickProject}
                />
                {/* Agent / mode / model as one grouped, animated picker — the
                  pills double as its tab strip. Cycling shortcuts (⌥/ agents,
                  ⇧⇥ Claude modes) are unchanged. The native agent's BYOK
                  pickers (ProviderModelPills etc.) stay separate below. */}
                <ComposerGroupsMenu
                  tabId={tabId}
                  currentAgent={switchableAgent}
                  onSwitchAgent={handleSwitchAgent}
                />
                {/* The BYOK ProviderModelPills used to render here for the
                  native agent — the user's own provider keys, which the
                  gateway agent cannot use. Model choice now goes through the
                  same ACP model pill as every other agent, fed by the seam's
                  published catalogue. */}
                {agentType === "atlas-agent" && <EffortPill tabId={tabId} />}
              </div>
              {/* Right side, in this order: the session's usage, the agent's own
                knobs, then the live
                implementation-plan pill hard against the right edge (arc
                progress + count; opens its own morphing task-list panel, and
                replaces the PlanDock strip that used to sit above the
                composer). Both are right-anchored dropups. */}
              <div className="flex shrink-0 items-center gap-1">
                <UsagePill tabId={tabId} />
                <ComposerOptionsPill tabId={tabId} />
                <PlanTasksPill tabId={tabId} />
              </div>
            </div>
          </div>
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

/** A value outside React that components subscribe to with
 *  `useSyncExternalStore`, so a change re-renders only its subscribers. */
function createValueStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

type ValueStore<T> = ReturnType<typeof createValueStore<T>>;

/** The slash picker, fed from the trigger store: per keystroke, only this
 *  re-renders. Memoized so the composer's own re-renders pass it by. */
const SlashPickerHost = memo(function SlashPickerHost({
  Picker,
  store,
  pickerRef,
  ...rest
}: {
  Picker: typeof SlashCommandPickerComponent;
  store: ValueStore<SlashTrigger | null>;
  pickerRef: Ref<SlashCommandPickerHandle>;
  onSelect: (cmd: SlashCommand) => void;
  commands: SlashCommand[];
  loading: boolean;
  footerLabel: string;
}) {
  const trigger = useSyncExternalStore(store.subscribe, store.get);
  return (
    <Picker
      ref={pickerRef}
      open={trigger !== null}
      query={trigger?.query ?? ""}
      anchor={trigger?.anchor ?? null}
      onClose={() => store.set(null)}
      {...rest}
    />
  );
});

function QueueChip({
  text,
  onEdit,
  onRemove,
}: {
  text: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-center gap-1 max-w-[260px] h-6 pl-2 pr-1 rounded-full border border-[var(--border)] bg-[var(--card)] text-xs text-[var(--secondary-foreground)]">
      <button
        onClick={onEdit}
        className="flex items-center gap-1 min-w-0 cursor-pointer hover:text-[var(--foreground)]"
        title="Edit / merge into input"
      >
        <Pencil size={9} className="text-[var(--muted-foreground)] shrink-0" />
        <span className="truncate">{text.replace(/\s+/g, " ")}</span>
      </button>
      <Hint label="Remove from queue" side="top">
        <button
          onClick={onRemove}
          className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-[var(--atlas-element-hover)] text-[var(--muted-foreground)] hover:text-[var(--atlas-status-error-foreground)] cursor-pointer shrink-0"
        >
          <X size={10} />
        </button>
      </Hint>
    </div>
  );
}
