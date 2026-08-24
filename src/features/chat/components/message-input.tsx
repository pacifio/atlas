import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  ArrowUp,
  Square,
  Pencil,
  X,
  Check,
  Loader2,
  Brain,
  Database,
  Cpu,
  ChevronDown,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import {
  CLAUDE_PERMISSION_MODE_LABEL,
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionMode,
  agentTypeFromPluginId,
  pluginIdForAgent,
  type SwitchableAgent,
} from "@/types/agent";
import {
  agentMeta,
  switchableAgentOf,
  useSwitchableAgents,
} from "@/features/agents/lib/agent-meta";
import { useAgentAcquire, acquirePercent } from "../lib/agent-acquire";
import { canSignIn, promptSignIn } from "../lib/agent-signin";
import { switchAgentForTab } from "@/features/chat/lib/switch-agent";
import { AgentMark } from "@/components/agent-mark";
import { ProviderModelPills } from "./provider-model-pills";
import { loadCerseiEffort, loadCerseiCompress } from "../lib/cersei-model-pref";
import { loadCachedAcpModels } from "../lib/acp-models-cache";
import { modelLabel } from "../lib/model-label";
// `ChatInput` pulls in CodeMirror (~870 KB) via `cm-mention-extension`.
// We import it dynamically so the chunk is not in the initial preload set.
// The import is kicked off at module-evaluation time (below, outside the
// component) so the chunk starts downloading the moment this module is
// reached in the import graph — *before* MessageInput even mounts. Until
// the chunk resolves the composer renders a same-sized empty placeholder
// so the panel doesn't reflow when CM lands.
//
// `MentionPicker` only mounts when the user types `@`, so we let its chunk
// load purely on demand — no eager preload (that would add a wasted Vite
// roundtrip in dev for every MessageInput mount).
import type { ChatInput as ChatInputComponent, ChatInputHandle } from "./chat-input";
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
import { RetryPill } from "./retry-pill";
import { ComposerAddMenu } from "./composer-add-menu";
import type { GithubRepo } from "@/features/github/types";
import { imageMimeFromPath } from "@/features/model-chat/lib/model-capabilities";
import type { ImageAttachment } from "@/types/agents";
import type {
  MentionFile,
  MentionWorkspace,
  MentionRepo,
  MentionPastSession,
  PastSessionRef,
} from "../lib/mentions";
import { toast } from "sonner";
import { parseConfigOptions } from "../lib/acp-config-options";
import { useComposerFileDrop } from "../hooks/use-composer-file-drop";
import { useProjectStore } from "@/features/project/stores/project-store";
import type { MentionTrigger } from "../lib/cm-mention-extension";
import type { SlashTrigger } from "../lib/cm-slash-extension";
// Value import — MUST come from the CodeMirror-free module, not from
// `cm-slash-extension` (see `cm-clear-range.ts`), or the composer's dynamic
// `import("./chat-input")` boundary below is defeated and the CodeMirror
// vendor chunk lands in the eager boot graph.
import { clearSlashRange } from "../lib/cm-clear-range";
import type { MentionData } from "../lib/mentions";

// Start the CodeMirror chunk download at module-evaluation time. Vite still
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

/** Read an image `File` (clipboard paste) into a base64 attachment. Returns
 *  null for non-images. The `data:` URI prefix is stripped — the wire shape
 *  carries raw base64 + mime separately. */
async function fileToImageAttachment(file: File): Promise<ImageAttachment | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  }).catch(() => null);
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(",");
  return {
    mimeType: file.type,
    dataBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
  };
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
  if (/full|bypass|\ball\b|danger|yolo|unrestricted/.test(id)) return "var(--status-error)";
  if (/read.?only|\bplan\b|ask|suggest/.test(id)) return "var(--accent-primary)";
  if (/auto|default|edit|accept|agent|workspace/.test(id)) return "var(--status-success)";
  return "var(--text-tertiary)";
}

interface CodebaseIndexStatus {
  indexed: boolean;
  // Rust serializes this struct as camelCase (see codebase_index.rs).
  fileCount: number;
  summaryCount: number;
  builtAtMs: number;
}

/** Codebase-index status pill for the native agent — the index that grounds
 *  `search_memory`. Shows file count (or "Index memory" when unbuilt), flips to
 *  "Indexing…" while the auto-indexer runs, and re-indexes on click. */
function CerseiMemoryPill() {
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const [status, setStatus] = useState<CodebaseIndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);

  const refresh = useCallback(() => {
    if (!projectPath) return;
    invoke<CodebaseIndexStatus>("codebase_index_status", { projectPath })
      .then(setStatus)
      .catch(() => {});
  }, [projectPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Track the auto-indexer (fired from App.tsx after a turn) for this project.
  useEffect(() => {
    const onIdx = (e: Event) => {
      const d = (e as CustomEvent<{ path: string; active: boolean }>).detail;
      if (!d || d.path !== projectPath) return;
      setIndexing(d.active);
      if (!d.active) refresh();
    };
    window.addEventListener("atlas:cersei-index", onIdx);
    return () => window.removeEventListener("atlas:cersei-index", onIdx);
  }, [projectPath, refresh]);

  const reindex = () => {
    if (!projectPath || indexing) return;
    setIndexing(true);
    void invoke("codebase_index_build", {
      projectPath,
      opts: { mode: "full", backend: "structural" },
    })
      .catch((err) => console.warn("manual codebase index failed:", err))
      .finally(() => {
        setIndexing(false);
        refresh();
      });
  };

  const label = indexing
    ? "Indexing…"
    : status?.indexed
      ? `${status.fileCount} indexed`
      : "Index memory";

  return (
    <button
      onClick={reindex}
      disabled={indexing}
      title="Codebase index that grounds the agent's memory recall — click to re-index"
      className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer tabular-nums disabled:cursor-default"
    >
      {indexing ? (
        <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />
      ) : (
        <Database
          size={11}
          className={
            status?.indexed ? "text-[var(--accent-primary)]" : "text-[var(--text-tertiary)]"
          }
        />
      )}
      {label}
    </button>
  );
}

const EFFORT_CYCLE = ["", "low", "medium", "high", "max"] as const;

/** Reasoning-effort pill for the native agent on Anthropic models (maps to a
 *  thinking budget). Cycles off → low → medium → high → max. Hidden for
 *  providers that don't support a thinking budget. */
function EffortPill({ tabId }: { tabId: string }) {
  const provider = useChatStore((s) => s.sessions[tabId]?.cerseiProvider ?? "");
  const effort = useChatStore((s) => s.sessions[tabId]?.cerseiEffort ?? "");
  const { setCerseiEffort } = useChatStore.use.actions();
  if (provider !== "anthropic") return null;
  const cycle = () => {
    const i = EFFORT_CYCLE.indexOf(effort as (typeof EFFORT_CYCLE)[number]);
    setCerseiEffort(tabId, EFFORT_CYCLE[(i + 1) % EFFORT_CYCLE.length]);
  };
  const active = effort !== "";
  return (
    <button
      onClick={cycle}
      className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
      title="Reasoning effort (thinking budget) — Anthropic models"
    >
      <Brain
        size={11}
        className={active ? "text-[var(--accent-primary)]" : "text-[var(--text-tertiary)]"}
      />
      {active ? `Think: ${effort}` : "Think"}
    </button>
  );
}

/** Compact tokens-used + cost pill for the native agent, plus a "compacting…"
 *  state while the context window is being summarized. Hidden until the first
 *  `usage_updated` delta lands. Narrow selectors so it only re-renders on its
 *  own session's usage/compaction changes. */
function CerseiUsagePill({ tabId }: { tabId: string }) {
  const usage = useChatStore((s) => s.sessions[tabId]?.usage);
  const compacting = useChatStore((s) => s.sessions[tabId]?.compacting ?? false);
  if (compacting) {
    return (
      <span
        className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--accent-primary)] select-none"
        title="Compacting the context window to stay within the model's limit"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-pulse" />
        Compacting…
      </span>
    );
  }
  if (!usage) return null;
  const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (total === 0) return null;
  const tokens = total >= 1000 ? `${(total / 1000).toFixed(1)}K` : `${total}`;
  const cost =
    usage.cost && usage.cost > 0 ? ` · $${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}` : "";
  return (
    <span
      className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-tertiary)] select-none tabular-nums"
      title={`${total.toLocaleString()} tokens (${usage.input_tokens?.toLocaleString()} in / ${usage.output_tokens?.toLocaleString()} out)${cost ? ` · est. $${usage.cost?.toFixed(4)}` : ""}`}
    >
      {tokens} tok{cost}
    </span>
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

type ComposerGroup = "agent" | "mode" | "model" | "options";
const GROUP_ORDER: ComposerGroup[] = ["agent", "mode", "model", "options"];

/** Colour class for the Claude permission-mode dot (mirrors the old pill). */
function claudeModeDotClass(mode: ClaudePermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "bg-[var(--status-success)]";
    case "plan":
      return "bg-[var(--accent-primary)]";
    case "bypassPermissions":
      return "bg-[var(--status-error)]";
    default:
      return "bg-[var(--text-tertiary)]";
  }
}

/**
 * The composer's grouped, animated picker — coding agent / permission mode /
 * model unified into one Skiper-style expanding menu. The pill row doubles as
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
  onSwitchAgent: (agent: SwitchableAgent) => void;
}) {
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  const permissionMode = useChatStore((s) => s.sessions[tabId]?.claudePermissionMode ?? "default");
  const currentMode = useChatStore((s) => s.sessions[tabId]?.acpCurrentMode);
  const availableModes = useChatStore((s) => s.sessions[tabId]?.acpAvailableModes);
  // P2.2: knobs the agent advertises beyond mode/model — a thinking select, a
  // web-search toggle. Kept current by the `config_options_updated` delta, so a
  // change made inside the agent shows here without a refetch.
  const rawConfigOptions = useChatStore((s) => s.sessions[tabId]?.acpConfigOptions);
  const configOptions = useMemo(() => parseConfigOptions(rawConfigOptions), [rawConfigOptions]);
  const modesPending = useChatStore((s) => s.sessions[tabId]?.acpModesPending ?? false);
  const currentModel = useChatStore((s) => s.sessions[tabId]?.acpCurrentModel);
  const availableModels = useChatStore((s) => s.sessions[tabId]?.acpAvailableModels);
  const { setAcpMode, setAcpModel, setClaudePermissionMode, setAcpConfigOption } =
    useChatStore.use.actions();
  const acquiring = useAgentAcquire(pluginIdForAgent(agentType));
  const switchableAgents = useSwitchableAgents();

  const [openGroup, setOpenGroup] = useState<ComposerGroup | null>(null);
  const [dir, setDir] = useState(1);
  const [q, setQ] = useState("");
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

  // Self-heal: the store is fed by the bind-time snapshot and the
  // `config_options_updated` delta, and a tab can render before either has
  // landed. Fall back to the persisted per-agent cache so the pill does not
  // flicker away in that gap.
  const models = useMemo(() => {
    if (availableModels && availableModels.length > 0) return availableModels;
    return loadCachedAcpModels(agentType)?.availableModels ?? [];
  }, [availableModels, agentType]);
  const filteredModels = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(s) ||
        m.id.toLowerCase().includes(s) ||
        (m.description ?? "").toLowerCase().includes(s),
    );
  }, [models, q]);

  const isClaude = agentType === "claude-code";
  const hasAcpModes = !!availableModes && availableModes.length > 0;
  const showMode = isClaude || hasAcpModes || modesPending;
  const showModel = agentType !== "cersei" && models.length > 0;

  const toggle = (g: ComposerGroup) => {
    setQ("");
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
  const labelCls = (_active: boolean) => "ml-1.5 whitespace-nowrap";
  const pillCls = (active: boolean) =>
    cn(
      "flex items-center px-1.5 h-6.5 rounded-full border text-[10px] leading-none font-medium transition-colors cursor-pointer",
      active
        ? "border-[var(--border-strong)] bg-[var(--bg-selected)] text-[var(--text-primary)]"
        : "border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
    );

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      {/* Shared morphing panel — ONE container whose height tweens to the
          measured size of whatever group is showing (ResizeObserver on the
          content), so open/close AND group→group switches all animate through
          the same surface — the reference's shared-layout feel. */}
      <div
        aria-hidden={!openGroup}
        className="absolute bottom-full left-0 z-50 mb-1.5 w-[300px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)]"
        style={{
          height: openGroup ? panelHeight : 0,
          opacity: openGroup ? 1 : 0,
          pointerEvents: openGroup ? "auto" : "none",
          transition: "height 260ms cubic-bezier(0.32,0.72,0,1), opacity 180ms ease-out",
        }}
      >
        <div ref={contentRef}>
          <div
            key={openGroup ?? "none"}
            className={cn(dir > 0 ? "atlas-group-slide-left" : "atlas-group-slide-right")}
          >
            {openGroup === "agent" && (
              <div className="max-h-[300px] overflow-y-auto hide-scrollbar p-1">
                {switchableAgents.map((a) => {
                  const active = a === currentAgent;
                  return (
                    <button
                      key={a}
                      onClick={() => {
                        if (!active) onSwitchAgent(a as SwitchableAgent);
                        close();
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                        active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      <AgentMark agentType={a} className="!h-4 !w-4 !text-[9px] !rounded" />
                      <span className="flex-1 truncate text-[11px] font-medium text-[var(--text-primary)]">
                        {agentMeta(a).label}
                      </span>
                      {active && <Check size={11} className="text-[var(--accent-primary)]" />}
                    </button>
                  );
                })}
              </div>
            )}

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
                        active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      <span
                        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", claudeModeDotClass(m))}
                      />
                      <span className="flex-1 text-[11px] font-medium text-[var(--text-primary)]">
                        {CLAUDE_PERMISSION_MODE_LABEL[m]}
                      </span>
                      {active && <Check size={11} className="text-[var(--accent-primary)]" />}
                    </button>
                  );
                })}
              </div>
            )}

            {openGroup === "mode" && !isClaude && (
              <div className="p-1">
                {!hasAcpModes ? (
                  <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-[var(--text-tertiary)]">
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
                          active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                        )}
                      >
                        <span
                          className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: acpModeColor(m.id) }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                            {displayModeName(m.name)}
                            {active && <Check size={11} className="text-[var(--accent-primary)]" />}
                          </span>
                          {m.description && (
                            <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-tertiary)]">
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

            {openGroup === "options" && (
              // Capped like the agent list above: the panel is bottom-anchored
              // and grows upward, so an uncapped knob list (an agent may
              // advertise a select with dozens of choices) clips its TOP —
              // which is the FIRST knob — off-screen.
              <div className="max-h-[300px] overflow-y-auto hide-scrollbar p-1">
                {configOptions.map((opt) => (
                  <div key={opt.id}>
                    {opt.kind === "boolean" ? (
                      <button
                        onClick={() => {
                          void setAcpConfigOption(tabId, opt.id, !opt.value);
                          close();
                        }}
                        className={cn(
                          "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                          "hover:bg-[var(--bg-hover)]",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                            {opt.name}
                            {opt.value && (
                              <Check size={11} className="text-[var(--accent-primary)]" />
                            )}
                          </span>
                          {opt.description && (
                            <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-tertiary)]">
                              {opt.description}
                            </span>
                          )}
                        </span>
                      </button>
                    ) : (
                      <>
                        <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                          {opt.name}
                        </div>
                        {opt.choices.map((c) => {
                          const active = c.id === opt.currentValue;
                          return (
                            <button
                              key={c.id}
                              onClick={() => {
                                void setAcpConfigOption(tabId, opt.id, c.id);
                                close();
                              }}
                              className={cn(
                                "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                                active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                              )}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                                  {c.name}
                                  {active && (
                                    <Check size={11} className="text-[var(--accent-primary)]" />
                                  )}
                                </span>
                                {c.description && (
                                  <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-tertiary)]">
                                    {c.description}
                                  </span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {openGroup === "model" && (
              <>
                <div className="flex h-8 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2.5">
                  <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search models…"
                    spellCheck={false}
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                  />
                </div>
                <div className="max-h-[280px] overflow-y-auto hide-scrollbar p-1">
                  {filteredModels.length === 0 ? (
                    <div className="px-2.5 py-2 text-[11px] text-[var(--text-tertiary)]">
                      No models
                    </div>
                  ) : (
                    filteredModels.map((m) => {
                      const active = m.id === currentModel;
                      return (
                        <button
                          key={m.id}
                          onClick={() => {
                            setAcpModel(tabId, m.id);
                            close();
                          }}
                          className={cn(
                            "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                            active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                              <span className="truncate">{modelLabel(m)}</span>
                              {active && (
                                <Check
                                  size={11}
                                  className="shrink-0 text-[var(--accent-primary)]"
                                />
                              )}
                            </span>
                            {m.description &&
                              m.description.trim().toLowerCase() !== "recommended" && (
                                <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-tertiary)] line-clamp-2">
                                  {m.description}
                                </span>
                              )}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Pill tab strip */}
      <button
        onClick={() => toggle("agent")}
        className={pillCls(openGroup === "agent")}
        title="Coding agent — pick here, ⌥/ cycles"
      >
        <AgentMark agentType={agentType} className="!h-4 !w-4 !text-[9px] !rounded" />
        <span className={labelCls(openGroup === "agent")}>{agentMeta(currentAgent).label}</span>
      </button>

      {acquiring ? (
        <span
          className="flex h-6.5 items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 text-[10px] font-medium leading-none text-[var(--text-tertiary)] select-none tabular-nums"
          title={`Downloading ${agentMeta(agentType).label} — this happens once.`}
        >
          <Loader2 size={11} className="shrink-0 animate-spin" />
          {acquirePercent(acquiring) !== null
            ? `Setting up ${agentMeta(agentType).label}… ${acquirePercent(acquiring)}%`
            : `Setting up ${agentMeta(agentType).label}…`}
        </span>
      ) : (
        showMode && (
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
            <span className={labelCls(openGroup === "mode")}>
              {isClaude
                ? CLAUDE_PERMISSION_MODE_LABEL[permissionMode]
                : currentAcpMode
                  ? displayModeName(currentAcpMode.name)
                  : modesPending
                    ? "Loading…"
                    : "Mode"}
            </span>
          </button>
        )
      )}

      {configOptions.length > 0 && (
        <button
          onClick={() => toggle("options")}
          className={pillCls(openGroup === "options")}
          title="Agent options — knobs this agent advertises"
        >
          <SlidersHorizontal size={11} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className={labelCls(openGroup === "options")}>Options</span>
          <ChevronDown size={10} className="ml-0.5 shrink-0 text-[var(--text-tertiary)]" />
        </button>
      )}

      {showModel && (
        <button
          onClick={() => toggle("model")}
          className={pillCls(openGroup === "model")}
          title="Model"
        >
          <Cpu size={11} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className={cn(labelCls(openGroup === "model"), "max-w-[120px] truncate")}>
            {currentModelInfo ? modelLabel(currentModelInfo) : (currentModel ?? "Model")}
          </span>
          <ChevronDown size={10} className="ml-0.5 shrink-0 text-[var(--text-tertiary)]" />
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
  disabled = false,
  placeholder = "Message Atlas... (@ to mention, / for commands)",
}: MessageInputProps) {
  const {
    enqueueMessage,
    removeQueueItem,
    setAcpModes,
    setAcpModesPending,
    setCerseiProvider,
    setCerseiModel,
    setCerseiEffort,
    setCerseiCompress,
  } = useChatStore.use.actions();
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
  const enterToSend = useProjectStore((s) => s.settings.enterToSend);
  // `agentType` normalised for the composer sub-components (session scope,
  // agent switcher) + the label lookup. This used to be a hardcoded list of the
  // six first-party agents with everything else falling through to
  // "claude-code" — so every registry-installed agent showed up in the pill as
  // "Claude Code", and the grouped picker's current-agent highlight (and
  // session scope) pointed at the wrong agent. `switchableAgentOf` passes
  // external ids through and collapses only the legacy "custom" placeholder,
  // which is what the transcript and sidebar already did.
  const switchableAgent: SwitchableAgent = switchableAgentOf(agentType);
  // Native Cersei agent only: BYOK provider + model selection for the composer.
  const cerseiProvider = useChatStore((s) => s.sessions[tabId]?.cerseiProvider ?? "");
  const cerseiModel = useChatStore((s) => s.sessions[tabId]?.acpCurrentModel ?? "");
  const onCerseiProvider = useCallback(
    (id: string) => setCerseiProvider(tabId, id),
    [tabId, setCerseiProvider],
  );
  const onCerseiModel = useCallback(
    (id: string) => setCerseiModel(tabId, id),
    [tabId, setCerseiModel],
  );
  // The composer may settle on a provider/model before the session is bound
  // (the `agents_set_model` push no-ops until then). Re-push once the binding
  // lands and a full selection exists — idempotent, mirrors the ACP mode
  // self-heal above. Without this the agent silently falls back to the server's
  // default model whenever the user's pick raced ahead of the bind.
  const cerseiBinding = useChatStore((s) => {
    const sess = s.sessions[tabId];
    if (sess?.agentType !== "cersei") return null;
    if (!sess.acpAgentId || !sess.acpSessionId) return null;
    if (!sess.cerseiProvider || !sess.acpCurrentModel) return null;
    return `${sess.acpAgentId}::${sess.acpSessionId}::${sess.acpCurrentModel}`;
  });
  useEffect(() => {
    if (!cerseiBinding) return;
    const model = cerseiBinding.split("::")[2];
    setCerseiModel(tabId, model);
  }, [tabId, cerseiBinding, setCerseiModel]);
  // Seed the reasoning-effort from the saved preference once per cersei session,
  // then re-push it whenever the session is bound (mirrors the model re-push).
  const cerseiEffort = useChatStore((s) => s.sessions[tabId]?.cerseiEffort);
  const cerseiBound = useChatStore((s) => {
    const sess = s.sessions[tabId];
    return sess?.agentType === "cersei" && !!sess.acpAgentId && !!sess.acpSessionId
      ? `${sess.acpAgentId}::${sess.acpSessionId}`
      : null;
  });
  useEffect(() => {
    if (agentType !== "cersei") return;
    // Undefined = never set for this session → seed from the global pref.
    const eff = cerseiEffort ?? loadCerseiEffort();
    if (cerseiBound || cerseiEffort === undefined) setCerseiEffort(tabId, eff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, agentType, cerseiBound]);
  // Same seed/re-push for the RTK compression toggle.
  const cerseiCompress = useChatStore((s) => s.sessions[tabId]?.cerseiCompress);
  useEffect(() => {
    if (agentType !== "cersei") return;
    const on = cerseiCompress ?? loadCerseiCompress();
    if (cerseiBound || cerseiCompress === undefined) setCerseiCompress(tabId, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, agentType, cerseiBound]);
  // ACP-reported slash commands for this session. Both adapters advertise
  // their real command list via `available_commands_update` — Codex's arrives
  // with the binding, Claude's a few seconds after session/new (the SDK
  // discovers skills/plugins/MCP prompts first). Per ADR 0003 there is no
  // fallback catalogue: the picker shows a loading state (see
  // `slashCommandsLoading` below) during that gap instead. The native agent
  // has no slash commands; its trigger is suppressed at the wiring site
  // below.
  const availableCommands = useChatStore((s) => s.sessions[tabId]?.availableCommands);
  const slashCommandsLoading = availableCommands === undefined;
  const agentSlashCommands = useMemo<SlashCommand[]>(() => {
    // Every ACP-transport agent gets its advertised commands — first-party AND
    // registry-installed externals (their agentType IS their plugin id). Only
    // the native cersei agent (no slash commands) and the legacy "custom"
    // placeholder bail out.
    if (agentType === "cersei" || agentType === "custom") return [];
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
    return [...(login ? [login] : []), ...fromAgent];
  }, [agentType, availableCommands]);
  const queue = useChatStore((s) => s.queues[tabId] ?? EMPTY_QUEUE);

  // CodeMirror owns the document; React only needs the empty↔non-empty EDGE
  // (for the submit button's tri-state). The old shape mirrored every doc
  // change into `useState` — re-rendering this whole component, footer menus
  // included, per keystroke — and ran an immer store write per keystroke via a
  // draft-sync effect (fanning out to every chat-store selector in the app).
  // Now the text lives in a ref, `hasText` flips only on the edge, and the
  // per-tab draft mirror is a 300ms trailing debounce + a flush on unmount
  // (tab switches unmount this component, so nothing is lost; the live-insert
  // paths go through `atlas:chat-insert`, not the draft).
  //
  // Initial seed reads the per-tab draft from chat-store. `useState`'s lazy
  // initializer runs once per mount with the mount-time tabId — exactly right.
  const [initialDraft] = useState(() => useChatStore.getState().drafts[tabId] ?? "");
  const valueRef = useRef(initialDraft);
  const [hasText, setHasText] = useState(() => initialDraft.trim().length > 0);
  const inputRef = useRef<ChatInputHandle>(null);

  const { setDraft } = useChatStore.use.actions();
  const draftTimer = useRef<number | null>(null);
  // Every path that updates the composer — typing, slash insertion, queue
  // recall — routes through this (it is the ChatInput onChange), so the ref,
  // the edge state and the draft mirror can't drift apart.
  const setValue = useCallback(
    (text: string) => {
      valueRef.current = text;
      const next = text.trim().length > 0;
      setHasText((prev) => (prev === next ? prev : next));
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
      draftTimer.current = window.setTimeout(() => {
        draftTimer.current = null;
        setDraft(tabId, valueRef.current);
      }, 300);
    },
    [tabId, setDraft],
  );
  useEffect(() => {
    return () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
      setDraft(tabId, valueRef.current);
    };
  }, [tabId, setDraft]);

  // The CM chunk started downloading at module-eval time (see the top of this
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
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const triggerRef = useRef<MentionTrigger | null>(null);
  triggerRef.current = trigger;

  // ── Slash-command picker orchestration ────────────────────────────────
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  // Close a picker left open across an agent switch — the new agent's
  // catalogue (or lack of one, for cersei) must not inherit the open state.
  useEffect(() => {
    if (agentType === "cersei") setSlashTrigger(null);
  }, [agentType]);
  const slashPickerRef = useRef<SlashCommandPickerHandle>(null);
  const slashTriggerRef = useRef<SlashTrigger | null>(null);
  slashTriggerRef.current = slashTrigger;

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

  const handleMentionSelect = useCallback((mention: MentionData) => {
    const t = triggerRef.current;
    if (!t) return;
    inputRef.current?.insertMention(mention, t.from, t.to);
    // Trigger naturally closes when the doc no longer has an `@…` before
    // the caret; the plugin will fire the null transition for us.
  }, []);

  // ── Drag-and-drop OS files onto the composer → attach as mention chips ──
  const composerRef = useRef<HTMLDivElement>(null);
  const handleDropFiles = useCallback(
    (paths: string[]) => {
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
        inputRef.current?.insertMention(mention);
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [projectPath],
  );
  const { isDropTarget } = useComposerFileDrop({
    targetRef: composerRef,
    enabled: !disabled,
    onDropFiles: handleDropFiles,
  });

  // ── Image attachments (multimodal input) ─────────────────────────────────
  // Images staged for the next send, shown as thumbnails above the input.
  // Only populated when the bound agent advertised promptCapabilities.image;
  // otherwise picked images degrade to path mention chips (any agent can
  // read those off disk).
  const [stagedImages, setStagedImages] = useState<ImageAttachment[]>([]);
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

  // "+" menu → "Add files or photos". The Tauri dialog hands back real
  // paths (a browser file input wouldn't), which is what makes the routing
  // possible: images become inline base64 attachments when the agent
  // supports them; everything else — and any unreadable image — becomes a
  // path mention chip via the same handler the drag-drop path uses.
  const pickFilesOrPhotos = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: true,
        title: "Attach files or photos",
      });
      if (!picked) return;
      const paths = (Array.isArray(picked) ? picked : [picked]) as string[];
      const images: ImageAttachment[] = [];
      const mentionPaths: string[] = [];
      for (const p of paths) {
        const mime = imageSupported ? imageMimeFromPath(p) : null;
        if (mime) {
          try {
            const data = await invoke<string>("read_file_base64", { path: p });
            images.push({ mimeType: mime, dataBase64: data });
            continue;
          } catch {
            // Unreadable as base64 → fall through to a path mention.
          }
        }
        mentionPaths.push(p);
      }
      if (images.length) setStagedImages((prev) => [...prev, ...images]);
      if (mentionPaths.length) handleDropFiles(mentionPaths);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      console.warn("attach picker failed:", err);
    }
  }, [imageSupported, handleDropFiles]);

  const handlePickWorkspace = useCallback((workspace: MentionWorkspace) => {
    inputRef.current?.insertMention(workspace);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // "+" menu → "Attach media". Same routing as the files picker, but the OS
  // dialog is filtered to image/video extensions. Images ride along as inline
  // base64 (when the agent supports it); video and anything unreadable become
  // path mention chips the agent reads off disk.
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
      const paths = (Array.isArray(picked) ? picked : [picked]) as string[];
      const images: ImageAttachment[] = [];
      const mentionPaths: string[] = [];
      for (const p of paths) {
        const mime = imageSupported ? imageMimeFromPath(p) : null;
        if (mime) {
          try {
            const data = await invoke<string>("read_file_base64", { path: p });
            images.push({ mimeType: mime, dataBase64: data });
            continue;
          } catch {
            // Unreadable as base64 → fall through to a path mention.
          }
        }
        mentionPaths.push(p);
      }
      if (images.length) setStagedImages((prev) => [...prev, ...images]);
      if (mentionPaths.length) handleDropFiles(mentionPaths);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      console.warn("media picker failed:", err);
    }
  }, [imageSupported, handleDropFiles]);

  // "+" menu → "Take a screenshot". Shells out to the native macOS
  // `screencapture` CLI (region selection or whole desktop), then attaches the
  // PNG — inline (multimodal) when the agent supports images, else as an @file
  // chip pointing at the saved `.atlas/screenshots/…` path.
  const handleTakeScreenshot = useCallback(
    async (mode: "region" | "full") => {
      try {
        // Let the "+" menu fully close first so it (and any dropdown) isn't caught
        // in a whole-desktop capture.
        await new Promise((r) => setTimeout(r, 250));
        const proj = useProjectStore.getState().currentProject?.path ?? null;
        const res = await invoke<{
          path: string;
          mimeType: string;
          dataBase64: string;
        } | null>("capture_screenshot", { mode, projectPath: proj });
        if (!res) return; // cancelled (Esc during region select)
        if (imageSupported) {
          setStagedImages((prev) => [
            ...prev,
            { mimeType: res.mimeType, dataBase64: res.dataBase64 },
          ]);
        } else {
          handleDropFiles([res.path]);
        }
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (err) {
        toast.error(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [imageSupported, handleDropFiles],
  );

  // "+" menu → "Add from GitHub". Shorthand for the GitHub panel's search+clone:
  // download the repo into `<project>/.atlas/repos`, lock the composer while it
  // syncs, then drop a `@repo:` chip carrying the local path so the agent
  // explores it (compose_prompt turns that chip into an "explore this repo"
  // block pointing at the absolute path).
  const handleCloneRepo = useCallback(async (repo: GithubRepo) => {
    const proj = useProjectStore.getState().currentProject?.path;
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
  }, []);

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
    (next: SwitchableAgent) => switchAgentForTab(tabId, next),
    [tabId],
  );

  // Clipboard images (screenshots) → staged attachments. Returning false
  // lets chat-input's default file-paste (native pasteboard → quoted paths)
  // handle everything else.
  const handlePasteImages = useCallback(
    (files: File[]) => {
      if (!imageSupported) return false;
      void Promise.all(files.map(fileToImageAttachment)).then((atts) => {
        const ok = atts.filter((a): a is ImageAttachment => a !== null);
        if (ok.length) setStagedImages((prev) => [...prev, ...ok]);
      });
      return true;
    },
    [imageSupported],
  );

  // `submit` (below) is defined after `handleSlashSelect` but the latter
  // needs to invoke it — routed through a ref (set right after `submit` is
  // declared) rather than a direct reference, since a `useCallback` deps
  // array is evaluated eagerly on every render and would otherwise read
  // `submit` before its `const` initializes.
  const submitRef = useRef<() => void>(() => {});

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      const t = slashTriggerRef.current;
      const view = inputRef.current?.view();
      if (!t || !view) return;

      if (cmd.handler === "agent-login") {
        // The one Atlas-handled command (S1): every agent opens the same
        // `AgentOAuthModal`. `reason` is passed so the modal can tell an
        // "agent wants a provider key" failure from a plain "not signed in".
        clearSlashRange(view, t.from, t.to);
        setSlashTrigger(null);
        promptSignIn(agentType, { reason: lastAuthReasonRef.current ?? undefined });
        inputRef.current?.focus();
        return;
      }

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
        clearSlashRange(view, t.from, t.to);
        setSlashTrigger(null);
        return;
      }
      if (commandRequiresArgs(cmd)) {
        // Drop `/<name> ` into the composer and put the caret at the
        // end so the user can fill in the required args. Don't send
        // until they press Enter.
        const insertText = `/${cmd.name} `;
        view.dispatch({
          changes: { from: t.from, to: t.to, insert: insertText },
          selection: { anchor: t.from + insertText.length },
        });
        setSlashTrigger(null);
        inputRef.current?.focus();
        return;
      }

      // No required args — commit the full command name in place of the
      // typed token (the query may be a prefix, e.g. "he" → "help"). Since
      // the trigger can sit mid-message, replacing just [from, to] preserves
      // any surrounding text instead of wiping the whole composer.
      const insertText = `/${cmd.name}`;
      view.dispatch({
        changes: { from: t.from, to: t.to, insert: insertText },
        selection: { anchor: t.from + insertText.length },
      });
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
    [disabled, agentType],
  );

  // Forward Up/Down/Enter/Esc/Backspace/Tab from CodeMirror to whichever
  // picker is open. Slash and mention pickers are mutually exclusive in
  // practice (each trigger requires its own sigil to open the token being
  // typed), but we still route deterministically.
  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape" | "Backspace" | "Tab") => {
      // Slash takes precedence when both happen to be open.
      const sp = slashPickerRef.current;
      const st = slashTriggerRef.current;
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
            // Let CM delete a query char or the `/` itself (which closes
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
            const view = inputRef.current?.view();
            if (!view) return true;
            const insertText = `/${active.name} `;
            view.dispatch({
              changes: { from: st.from, to: st.to, insert: insertText },
              selection: { anchor: st.from + insertText.length },
            });
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
          // empty — otherwise let CM delete a character in the query (or
          // the `@` itself, which closes the picker via the trigger
          // detector).
          if (t.query === "" && p.goBack()) return true;
          return false;
        case "Tab":
          // Not handled for the mention picker — fall through to CM's
          // default Tab handling (list indent / outdent).
          return false;
      }
    },
    [],
  );

  // Auto-focus the composer whenever this panel mounts (tab switch back into
  // chat). If the CodeMirror chunk hasn't resolved yet, the next re-render
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
      const cur = inputRef.current?.getValue() ?? "";
      const next = `${quoted}\n\n${cur}`;
      inputRef.current?.setValue(next);
      setValue(next);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-reply", handler);
    return () => window.removeEventListener("atlas:chat-reply", handler);
  }, []);

  // Prefill the composer with raw text (empty-state prompt chips). Unlike
  // "reply" this replaces the value verbatim (no quote block) and focuses.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (!detail?.text) return;
      inputRef.current?.setValue(detail.text);
      setValue(detail.text);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-prefill", handler);
    return () => window.removeEventListener("atlas:chat-prefill", handler);
  }, []);

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
      const detail = (e as CustomEvent<{ text: string; tabId?: string }>).detail;
      if (!detail?.text) return;
      if (detail.tabId) {
        // Tab-targeted insert (KB "send selection to chat"). The sender
        // already appended to this tab's draft, so `text` is the full
        // composed value — replace, don't append, to avoid doubling.
        if (detail.tabId !== tabId) return;
        inputRef.current?.setValue(detail.text);
        setValue(detail.text);
      } else {
        // Legacy untargeted insert — only the active session reacts and
        // the text is appended to whatever's already in the composer.
        if (useChatStore.getState().activeSessionId !== tabId) return;
        const cur = inputRef.current?.getValue() ?? "";
        const next = cur.trim() ? `${cur}\n\n${detail.text}` : detail.text;
        inputRef.current?.setValue(next);
        setValue(next);
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-insert", handler);
    return () => window.removeEventListener("atlas:chat-insert", handler);
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
    const mentions = inputRef.current?.getMentions() ?? [];
    if (running) {
      // Queued messages don't carry mentions yet — the queue holds raw
      // strings and the agent will see whatever shortform text was in the
      // composer. Mentions are dropped here intentionally; promoting the
      // queue to a structured shape is a follow-up. Staged images likewise
      // stay in the composer strip and ride the next direct send.
      enqueueMessage(tabId, trimmed);
    } else {
      const images = stagedImages;
      onSend(trimmed, mentions, images.length ? images : undefined);
      if (images.length) setStagedImages([]);
    }
    inputRef.current?.clear();
    setValue("");
    // The debounced draft mirror will collapse the empty value into a
    // `delete s.drafts[tabId]`, so no explicit clearDraft call is needed.
  }, [
    setValue,
    running,
    onSend,
    onStop,
    enqueueMessage,
    tabId,
    disabled,
    stagedImages,
    githubSyncing,
  ]);
  submitRef.current = submit;

  // Tri-state button:
  //   running + empty   → STOP
  //   running + text    → QUEUE
  //   not running + any → SEND
  type Mode = "send" | "queue" | "stop";
  const mode: Mode = running ? (hasText ? "queue" : "stop") : "send";
  const buttonEnabled = disabled ? false : mode === "stop" ? true : hasText;

  // A fixed, generic placeholder ("Ask Claude Code / Codex what to do…") — the
  // composer no longer mirrors the setup phase here (the setup pill above the
  // input already communicates install/auth state). Only the queue hint
  // overrides it.
  const effectivePlaceholder = running ? "Type to queue the next message…" : placeholder;

  return (
    <div className="px-4 pb-4 pt-2 bg-transparent">
      <div className="max-w-[720px] mx-auto">
        {/* Queued messages above the input */}
        {queue.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] px-1">
              Queued · {queue.length}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {queue.map((q, i) => (
                <QueueChip
                  key={i}
                  text={q}
                  onEdit={() => {
                    const cur = inputRef.current?.getValue() ?? "";
                    const merged = cur.trim() ? `${cur}\n${q}` : q;
                    inputRef.current?.setValue(merged);
                    setValue(merged);
                    removeQueueItem(tabId, i);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  onRemove={() => removeQueueItem(tabId, i)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Transient-failure retry countdown (native agent). */}
        <RetryPill tabId={tabId} />

        {/* Live plan docked on top of the input bar (JetBrains-Air style). */}

        <div
          ref={composerRef}
          data-chat-composer
          className={cn(
            // Positioned + z-indexed so the composer paints over — and visually
            // tucks — the PlanDock's bottom edge (the attached-panel recipe).
            //
            // The VALUE has to clear the floating pill row above the composer
            // (`z-20` in chat-panel.tsx), not just the PlanDock. This element
            // has a z-index, so it opens a stacking context, and every dropup
            // inside it — the model picker, the agent/mode picker, the toolbar
            // tooltip — is trapped in it: their `z-50` sorts them against each
            // other and against nothing else. At `z-10` the whole composer,
            // menus included, painted UNDER the "Scroll to bottom" pill, which
            // also swallowed clicks on the menu's first row (the pill sets
            // `pointer-events-auto`). Raising the context is the fix; raising
            // the menus themselves cannot work from inside it.
            // Two-layer shell: this OUTER muted layer carries the toolbar as
            // its exposed bottom strip; the INNER surface below holds the
            // input + send button (the focus ring lives there — the "active
            // field" is the input surface, not the toolbar).
            "relative z-30 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)]",
            "shadow-[0_8px_24px_rgba(0,0,0,0.35)]",
            // Drag-over highlight: a clear accent ring while OS files hover.
            isDropTarget && "border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]/40",
            // Hard-disable when the bound agent isn't ready. Dim only — the
            // pointer block lives on the INPUT wrapper below, never on the
            // whole composer: the agent switcher sits in this toolbar, and
            // blocking it meant a user without Claude Code could never reach
            // another agent (the composer was a dead end on a fresh install).
            // No red tint — the send button is already disabled and
            // submit()/Cmd+Enter are gated on `disabled`.
            disabled && "opacity-60",
            // Lock the composer while a GitHub repo syncs into `.atlas/repos`.
            githubSyncing !== null && "opacity-60 pointer-events-none",
          )}
          onFocusCapture={handleFocusCapture}
        >
          {githubSyncing !== null && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--bg-base)]/40 backdrop-blur-[1px]">
              <span className="flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)] shadow">
                <Loader2 size={12} className="animate-spin" />
                Syncing {githubSyncing}…
              </span>
            </div>
          )}
          {isDropTarget && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--accent-primary)]/8 backdrop-blur-[1px]">
              <span className="rounded-full bg-[var(--bg-elevated)] px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)] shadow">
                Drop files to attach
              </span>
            </div>
          )}
          {/* Inner input surface — nested card with its own border + focus
              glow, sitting proud of the muted shell (reference: the Skiper
              double-layer composer). The send button lives INSIDE it. */}
          <div
            className={cn(
              "relative m-1 rounded-xl border border-[var(--border-default)] bg-[var(--bg-base)]",
              "transition-[border-color,box-shadow] duration-150",
              // Focus treatment at HALF strength: the full border-focus +
              // /20 accent ring read far too loud on the nested surface.
              "focus-within:border-[color-mix(in_srgb,var(--border-focus)_50%,var(--border-default))]",
              "focus-within:ring-1 focus-within:ring-[var(--accent-primary)]/10",
            )}
          >
            {stagedImages.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {stagedImages.map((img, i) => {
                  const src = `data:${img.mimeType};base64,${img.dataBase64}`;
                  return (
                    <div key={i} className="relative group">
                      <img
                        src={src}
                        alt="attachment"
                        className="h-14 w-14 object-cover rounded-lg border border-[var(--border-default)]"
                      />
                      <button
                        onClick={() => setStagedImages((prev) => prev.filter((_, j) => j !== i))}
                        className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                        title="Remove image"
                      >
                        <X size={9} />
                      </button>
                      {/* Zed-style hover preview — a larger floating image above the
                        thumbnail. `pointer-events-none` so it never blocks the
                        remove button; only shown on hover. */}
                      <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 hidden group-hover:block">
                        <img
                          src={src}
                          alt=""
                          className="max-h-[320px] max-w-[400px] rounded-lg border border-[var(--border-default)] object-contain bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)]"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Only the text area is pointer-blocked while `disabled`:
              `pointer-events-none` stops click-to-focus/typing AND the focus
              event, so we never trigger the agent-bind listener against a CLI
              that isn't ready. The toolbar below stays live so the agent /
              model pickers remain reachable. */}
            {/* px padding (not rem — see the send button's geometry note):
                clears the 28px button + 8px inset at any UI scale. */}
            <div className={cn("pr-[40px]", disabled && "pointer-events-none")}>
              {LazyChatInput ? (
                <LazyChatInput
                  ref={inputRef}
                  initialValue={valueRef.current}
                  placeholder={effectivePlaceholder}
                  onChange={setValue}
                  onSubmit={submit}
                  enterToSend={enterToSend}
                  onMentionTrigger={setTrigger}
                  // The native agent has no slash commands — suppressing the
                  // trigger here (rather than showing an empty picker) keeps "/"
                  // as plain text for cersei.
                  onSlashTrigger={agentType === "cersei" ? undefined : setSlashTrigger}
                  onPasteImages={handlePasteImages}
                  keyInterceptor={keyInterceptor}
                />
              ) : (
                // Same-height empty slot so the panel layout doesn't reflow when
                // CodeMirror lands. Non-interactive — by the time the user can
                // visually find this region the chunk has typically resolved.
                <div aria-hidden="true" style={{ minHeight: 44 }} className="px-4 pt-3 pb-1" />
              )}
            </div>
            <button
              onClick={submit}
              disabled={!buttonEnabled}
              className={cn(
                // Reference-style squircle send: a soft rounded-square,
                // transparent at rest, muted fill + border on hover, pinned
                // top-right of the input surface (it does not ride down as
                // the field grows — same as the Skiper component).
                // Geometry IN PX, not rem: Atlas's UI-scale setting shrinks
                // the root font-size, so rem utilities (w-7/top-2 → 23px/6.5px
                // under scale) drift against CodeMirror's hardcoded 12px/16px
                // padding — the ruler-measured misalignment. CM's first text
                // line centers at 12px pad + ~10px half-line = 22px; a 28px
                // button at 8px top centers at 22px at EVERY UI scale.
                "absolute top-[8px] right-[8px] flex items-center justify-center w-[28px] h-[28px] rounded-lg border transition-colors",
                buttonEnabled
                  ? "border-transparent text-[var(--text-primary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-default)] cursor-pointer"
                  : "border-transparent text-[var(--text-tertiary)] cursor-not-allowed",
              )}
              title={
                mode === "stop"
                  ? stopping
                    ? "Stopping… (waiting for the agent to wind down)"
                    : "Stop generation"
                  : mode === "queue"
                    ? "Queue message (sends after current finishes)"
                    : `Send to agent (${enterToSend ? "↵" : "⌘↵"})`
              }
            >
              {/* Keyed span so the arrow↔stop swap plays the scale-pop morph
                (existing `animate-scale-in` — ends at identity, no fill). */}
              <span
                key={mode === "stop" ? "stop" : "send"}
                className="flex items-center justify-center animate-scale-in"
              >
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
          </div>
          {/* Footer strip — the exposed band of the outer shell. */}
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <div className="flex items-center gap-1">
              <ComposerAddMenu
                disabled={disabled || githubSyncing !== null}
                projectPath={useProjectStore.getState().currentProject?.path ?? null}
                agentId={switchableAgent}
                imageSupported={imageSupported}
                onAddFilesOrPhotos={() => void pickFilesOrPhotos()}
                onAttachMedia={() => void pickMedia()}
                onTakeScreenshot={(mode) => void handleTakeScreenshot(mode)}
                onCloneRepo={(repo) => void handleCloneRepo(repo)}
                onPickSession={handlePickSession}
                onPickWorkspace={handlePickWorkspace}
                currentAgent={switchableAgent}
                onSwitchAgent={handleSwitchAgent}
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
              {agentType === "cersei" && (
                <ProviderModelPills
                  provider={cerseiProvider}
                  model={cerseiModel}
                  onProvider={onCerseiProvider}
                  onModel={onCerseiModel}
                  compress={cerseiCompress ?? true}
                  onCompress={(on) => setCerseiCompress(tabId, on)}
                />
              )}
              {agentType === "cersei" && <EffortPill tabId={tabId} />}
              {agentType === "cersei" && <CerseiMemoryPill />}
              {agentType === "cersei" && <CerseiUsagePill tabId={tabId} />}
            </div>
            {/* Right side: the live implementation-plan pill (arc progress +
                count; opens its own morphing task-list panel). Replaces the
                PlanDock strip that used to sit above the composer. */}
            <PlanTasksPill tabId={tabId} />
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
          onSelect={handleMentionSelect}
          onClose={() => setTrigger(null)}
        />
      )}
      {LazySlashPicker && (
        <LazySlashPicker
          ref={slashPickerRef}
          open={slashTrigger !== null}
          query={slashTrigger?.query ?? ""}
          anchor={slashTrigger?.anchor ?? null}
          onSelect={handleSlashSelect}
          onClose={() => setSlashTrigger(null)}
          commands={agentSlashCommands}
          loading={slashCommandsLoading}
          footerLabel={
            agentType === "codex"
              ? "Codex commands"
              : agentType === "opencode"
                ? "OpenCode commands"
                : agentType === "cursor"
                  ? "Cursor commands"
                  : agentType === "claude-code"
                    ? "Claude Code commands"
                    : undefined
          }
        />
      )}
    </div>
  );
}

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
    <div className="group flex items-center gap-1 max-w-[260px] h-6 pl-2 pr-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[11px] text-[var(--text-secondary)]">
      <button
        onClick={onEdit}
        className="flex items-center gap-1 min-w-0 cursor-pointer hover:text-[var(--text-primary)]"
        title="Edit / merge into input"
      >
        <Pencil size={9} className="text-[var(--text-tertiary)] shrink-0" />
        <span className="truncate">{text.replace(/\s+/g, " ")}</span>
      </button>
      <button
        onClick={onRemove}
        className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--status-error)] cursor-pointer shrink-0"
        title="Remove from queue"
      >
        <X size={10} />
      </button>
    </div>
  );
}
