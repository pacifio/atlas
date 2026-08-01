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
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../stores/chat-store";
import { agents } from "../lib/agents-api";
import { CLAUDE_PERMISSION_MODE_LABEL, AGENT_LABEL, agentTypeFromPluginId, type SwitchableAgent } from "@/types/agent";
import { AgentMark } from "@/components/agent-mark";
import { ProviderModelPills } from "./provider-model-pills";
import { loadCerseiEffort, loadCerseiCompress } from "../lib/cersei-model-pref";
import { loadCachedAcpModels } from "../lib/acp-models-cache";
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
import { CodexLoginDialog } from "./codex-login-dialog";
import { PlanDock } from "./plan-dock";
import { RetryPill } from "./retry-pill";
import { ComposerAddMenu } from "./composer-add-menu";
import type { GithubRepo } from "@/features/github/types";
import { imageMimeFromPath } from "@/features/model-chat/lib/model-capabilities";
import type { ImageAttachment } from "@/types/agents";
import type {
  MentionFile,
  MentionSkill,
  MentionWorkspace,
  MentionRepo,
  MentionPastSession,
  PastSessionRef,
} from "../lib/mentions";
import { toast } from "sonner";
import { useComposerFileDrop } from "../hooks/use-composer-file-drop";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import type { MentionTrigger } from "../lib/cm-mention-extension";
import type { SlashTrigger } from "../lib/cm-slash-extension";
import { clearSlashRange } from "../lib/cm-slash-extension";
import type { MentionData } from "../lib/mentions";

// Start the CodeMirror chunk download at module-evaluation time. Vite still
// excludes it from `<link rel="modulepreload">` because the static analysis
// only sees a dynamic `import()`. The promise is reused by every MessageInput
// instance.
const chatInputPromise: Promise<typeof import("./chat-input")> =
  import("./chat-input");
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
  onSend: (
    message: string,
    mentions: MentionData[],
    attachments?: ImageAttachment[],
  ) => void;
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
        <Database size={11} className={status?.indexed ? "text-[var(--accent-primary)]" : "text-[var(--text-tertiary)]"} />
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
  const cost = usage.cost && usage.cost > 0 ? ` · $${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}` : "";
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
function AcpModePicker({ tabId }: { tabId: string }) {
  const currentMode = useChatStore((s) => s.sessions[tabId]?.acpCurrentMode);
  const availableModes = useChatStore((s) => s.sessions[tabId]?.acpAvailableModes);
  const pending = useChatStore((s) => s.sessions[tabId]?.acpModesPending ?? false);
  const { setAcpMode } = useChatStore.use.actions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const hasModes = !!availableModes && availableModes.length > 0;

  // Still booting the session with nothing cached to show — a pure loading
  // pill so the user sees the agent coming up instead of an empty composer.
  if (!hasModes) {
    if (!pending) return null;
    return (
      <span
        className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-tertiary)] select-none"
        title="Starting agent…"
      >
        <Loader2 size={11} className="shrink-0 animate-spin" />
        Loading modes…
      </span>
    );
  }

  const current = availableModes!.find((m) => m.id === currentMode);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        title="Permission mode"
      >
        {/* We already have (cached) modes — render the pill as settled for an
            instant, Claude-like feel. The live session reconciles silently in
            the background; no spinner, since the cached modes are usable now. */}
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: acpModeColor(currentMode) }}
        />
        {current?.name ?? "Mode"}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[200px] max-w-[280px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1 shadow-lg">
          {availableModes.map((m) => {
            const active = m.id === currentMode;
            return (
              <button
                key={m.id}
                onClick={() => {
                  setAcpMode(tabId, m.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors",
                  active
                    ? "bg-[var(--bg-selected)]"
                    : "hover:bg-[var(--bg-hover)]"
                )}
              >
                <span
                  className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: acpModeColor(m.id) }}
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                    {m.name}
                    {active && (
                      <Check size={11} className="text-[var(--accent-primary)]" />
                    )}
                  </span>
                  {m.description && (
                    <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-tertiary)]">
                      {m.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Composer model picker for the ACP agents (Claude Code / Codex). These agents
 * advertise their selectable models (id + name + description) in `session/new`
 * — ACP's first-party model selection, the same surface Zed drives. We render a
 * dropup mirroring the mode picker. Hidden when the agent exposes no models or
 * for the native agent (which uses ProviderModelPills + its BYOK catalog).
 */
/** Claude Code advertises its default model as "Recommended"; show "Default". */
function modelLabel(m: { id: string; name: string }): string {
  if (m.name.trim().toLowerCase() === "recommended" || m.id === "default") return "Default";
  return m.name;
}

function AcpModelPicker({ tabId }: { tabId: string }) {
  const currentModel = useChatStore((s) => s.sessions[tabId]?.acpCurrentModel);
  const availableModels = useChatStore((s) => s.sessions[tabId]?.acpAvailableModels);
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  const { setAcpModel } = useChatStore.use.actions();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Self-heal: ACP `session/load` doesn't re-advertise models, so a resumed /
  // re-bound session can hold an empty list even though the agent has one —
  // and hiding the picker on empty is exactly the "model selector disappears
  // mid-session" bug. Fall back to the persisted per-agent cache (the mode
  // picker self-heals the same way).
  const models = useMemo(() => {
    if (availableModels && availableModels.length > 0) return availableModels;
    return loadCachedAcpModels(agentType)?.availableModels ?? [];
  }, [availableModels, agentType]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(s) ||
        m.id.toLowerCase().includes(s) ||
        (m.description ?? "").toLowerCase().includes(s),
    );
  }, [models, q]);

  if (models.length === 0) return null;
  const current = models.find((m) => m.id === currentModel);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setQ("");
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        title="Model"
      >
        <Cpu size={11} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="max-w-[120px] truncate">{current ? modelLabel(current) : (currentModel ?? "Model")}</span>
        <ChevronDown size={10} className="shrink-0 text-[var(--text-tertiary)]" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 w-[260px] overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-lg">
          {/* Search combobox */}
          <div className="flex items-center gap-1.5 h-8 border-b border-[var(--border-subtle)] px-2.5">
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
            {filtered.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] text-[var(--text-tertiary)]">No models</div>
            ) : (
              filtered.map((m) => {
                const active = m.id === currentModel;
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      setAcpModel(tabId, m.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                      active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                    )}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                        <span className="truncate">{modelLabel(m)}</span>
                        {active && (
                          <Check size={11} className="shrink-0 text-[var(--accent-primary)]" />
                        )}
                      </span>
                      {m.description && m.description.trim().toLowerCase() !== "recommended" && (
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
        </div>
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
    cycleClaudePermissionMode,
    enqueueMessage,
    removeQueueItem,
    setAcpModes,
    setAcpModesPending,
    setCerseiProvider,
    setCerseiModel,
    setCerseiEffort,
    setCerseiCompress,
  } = useChatStore.use.actions();
  // Codex/other ACP agents advertise their own permission modes; show the
  // picker only when this session actually has modes (Claude uses its own pill).
  const hasAcpModes = useChatStore(
    (s) => (s.sessions[tabId]?.acpAvailableModes?.length ?? 0) > 0
  );
  // Show the picker as soon as the agent is non-Claude — even before its modes
  // load — so the composer can render a loading pill instead of nothing during
  // the agent spawn + new_session boot.
  const acpModesPending = useChatStore(
    (s) => s.sessions[tabId]?.acpModesPending ?? false
  );
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
        const snap = await agents.snapshot({ agent_id, session_id });
        if (!cancelled && snap.available_modes.length > 0) {
          setAcpModes(
            tabId,
            snap.current_mode,
            snap.available_modes,
            agentTypeFromPluginId(snap.plugin_id)
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
  // Safety net: an agent whose boot hangs (e.g. Codex's models-refresh times out
  // waiting on a child process) never resolves `new_session`, so the create
  // effect's `setAcpModesPending(false)` never runs and the picker spins
  // forever. Time the loading state out so the pill settles regardless — if the
  // binding lands later, the self-heal above still seeds the real modes; any
  // optimistic cached modes simply stay shown without the spinner.
  useEffect(() => {
    if (!acpModesPending) return;
    const t = setTimeout(() => setAcpModesPending(tabId, false), 12000);
    return () => clearTimeout(t);
  }, [tabId, acpModesPending, setAcpModesPending]);
  // Narrow per-tab selectors — primitives only, no message-array refs. This
  // component otherwise would re-render on every streaming chunk because it
  // sits inside the active chat panel.
  const permissionMode = useChatStore(
    (s) => s.sessions[tabId]?.claudePermissionMode ?? "default"
  );
  const agentType = useChatStore(
    (s) => s.sessions[tabId]?.agentType ?? "claude-code"
  );
  // Settings → General → "Enter to send" (#51). Narrow selector so a toggle
  // flip only re-renders composers, not the whole settings surface.
  const enterToSend = useProjectStore((s) => s.settings.enterToSend);
  // `agentType` widened to a SwitchableAgent (drops "custom") for the composer
  // sub-components (skill/session scope, agent switcher) + the label lookup.
  const switchableAgent: SwitchableAgent =
    agentType === "codex" ? "codex" : agentType === "cersei" ? "cersei" : "claude-code";
  // Native Cersei agent only: BYOK provider + model selection for the composer.
  const cerseiProvider = useChatStore((s) => s.sessions[tabId]?.cerseiProvider ?? "");
  const cerseiModel = useChatStore((s) => s.sessions[tabId]?.acpCurrentModel ?? "");
  const onCerseiProvider = useCallback(
    (id: string) => setCerseiProvider(tabId, id),
    [tabId, setCerseiProvider]
  );
  const onCerseiModel = useCallback(
    (id: string) => setCerseiModel(tabId, id),
    [tabId, setCerseiModel]
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
  // ACP-reported slash commands for this session (Codex). Claude keeps its
  // curated catalogue (the picker's default).
  const availableCommands = useChatStore((s) => s.sessions[tabId]?.availableCommands);
  const agentSlashCommands = useMemo<SlashCommand[] | undefined>(() => {
    if (agentType !== "codex") return undefined;
    const fromAgent: SlashCommand[] = (availableCommands ?? [])
      .map((c) => {
        const o = (c ?? {}) as { name?: string; description?: string; input?: unknown };
        const name = (o.name ?? "").replace(/^\//, "");
        return {
          name,
          signature: o.input != null ? `/${name} <args>` : `/${name}`,
          description: o.description ?? "",
          handler: "passthrough" as const,
        };
      })
      .filter((c) => c.name && c.name !== "login");
    // Custom Atlas-handled command (not advertised by codex-acp): opens the
    // Codex sign-in modal — mirrors Claude's `/login`.
    return [
      {
        name: "login",
        signature: "/login",
        description: "Sign in to Codex (ChatGPT or API key).",
        handler: "codex-login" as const,
      },
      ...fromAgent,
    ];
  }, [agentType, availableCommands]);
  const queue = useChatStore((s) => s.queues[tabId] ?? EMPTY_QUEUE);

  // The composer's plain-text content is mirrored into local state so the
  // submit button can react to emptiness without round-tripping through
  // CodeMirror on every keystroke. CodeMirror owns the document; this is a
  // shallow shadow for the submit button.
  //
  // Initial seed reads the per-tab draft from chat-store so switching tabs
  // (which unmounts this component) doesn't drop what the user was typing.
  // `useState`'s lazy initializer runs once per mount with the tabId that
  // was current at mount time — that's exactly what we want.
  const [value, setValue] = useState(
    () => useChatStore.getState().drafts[tabId] ?? "",
  );
  const inputRef = useRef<ChatInputHandle>(null);

  // Mirror every doc change into the per-tab draft slot. Using an
  // effect (rather than wrapping each setValue callsite) means every
  // path that updates the composer — typing, slash insertion, queue
  // recall — keeps the store in sync without having to remember.
  const { setDraft } = useChatStore.use.actions();
  useEffect(() => {
    setDraft(tabId, value);
  }, [value, tabId, setDraft]);

  // The CM chunk started downloading at module-eval time (see the top of this
  // file). Mirror the resolution into component state so React re-renders
  // once the component class is available. We never render a textarea
  // fallback — instead the placeholder div below holds the layout slot at
  // the same height so the swap is invisible (no reflow, no mount/unmount
  // of an interactive element mid-typing).
  const [LazyChatInput, setLazyChatInput] =
    useState<typeof ChatInputComponent | null>(null);
  const [LazyMentionPicker, setLazyMentionPicker] =
    useState<typeof MentionPickerComponent | null>(null);
  const [LazySlashPicker, setLazySlashPicker] =
    useState<typeof SlashCommandPickerComponent | null>(null);

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
    if (focusedOnceRef.current) return;
    focusedOnceRef.current = true;
    window.dispatchEvent(
      new CustomEvent("atlas:chat-input-focused", { detail: { tabId } })
    );
  }, [tabId]);

  // ── Mention picker orchestration ──────────────────────────────────────
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const pickerRef = useRef<MentionPickerHandle>(null);
  const triggerRef = useRef<MentionTrigger | null>(null);
  triggerRef.current = trigger;

  // ── Slash-command picker orchestration ────────────────────────────────
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const [codexLoginOpen, setCodexLoginOpen] = useState(false);
  const slashPickerRef = useRef<SlashCommandPickerHandle>(null);
  const slashTriggerRef = useRef<SlashTrigger | null>(null);
  slashTriggerRef.current = slashTrigger;
  const { openLoginDialog } = useClaudeSetupStore.use.actions();

  // An auth-classified turn failure routes to the sign-in flow (P15) instead
  // of dying as a generic banner. Claude sessions open the login dialog; the
  // Codex sign-in pill is handled in ChatComposer (it owns that probe state).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; agentType?: string }>).detail;
      if (detail?.agentType !== "claude-code") return;
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess?.acpSessionId || sess.acpSessionId !== detail.sessionId) return;
      openLoginDialog();
    };
    window.addEventListener("atlas:auth-required", handler);
    return () => window.removeEventListener("atlas:auth-required", handler);
  }, [tabId, openLoginDialog]);

  const handleMentionSelect = useCallback(
    (mention: MentionData) => {
      const t = triggerRef.current;
      if (!t) return;
      inputRef.current?.insertMention(mention, t.from, t.to);
      // Trigger naturally closes when the doc no longer has an `@…` before
      // the caret; the plugin will fire the null transition for us.
    },
    []
  );

  // ── Drag-and-drop OS files onto the composer → attach as mention chips ──
  const composerRef = useRef<HTMLDivElement>(null);
  const handleDropFiles = useCallback(
    (paths: string[]) => {
      const root =
        projectPath && !projectPath.endsWith("/") ? `${projectPath}/` : projectPath;
      for (const abs of paths) {
        // Relative-to-project display name when the file lives inside the
        // project; otherwise just the basename (dropped files can be anywhere).
        const displayName =
          root && abs.startsWith(root)
            ? abs.slice(root.length)
            : abs.split("/").pop() || abs;
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
    [projectPath]
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
      .snapshot({ agent_id, session_id })
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
      const picked = await open({ multiple: true, title: "Attach files or photos" });
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

  const handlePickSkill = useCallback((skill: MentionSkill) => {
    inputRef.current?.insertMention(skill);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

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
              "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg",
              "mp4", "mov", "webm", "m4v", "avi", "mkv",
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
  const handleTakeScreenshot = useCallback(async (mode: "region" | "full") => {
    try {
      // Let the "+" menu fully close first so it (and any dropdown) isn't caught
      // in a whole-desktop capture.
      await new Promise((r) => setTimeout(r, 250));
      const proj = useProjectStore.getState().currentProject?.path ?? null;
      const res = await invoke<{ path: string; mimeType: string; dataBase64: string } | null>(
        "capture_screenshot",
        { mode, projectPath: proj },
      );
      if (!res) return; // cancelled (Esc during region select)
      if (imageSupported) {
        setStagedImages((prev) => [...prev, { mimeType: res.mimeType, dataBase64: res.dataBase64 }]);
      } else {
        handleDropFiles([res.path]);
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      toast.error(
        `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [imageSupported, handleDropFiles]);

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
      filePath: session.filePath,
    };
    inputRef.current?.insertMention(mention);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // "+" menu footer → agent switcher. Mirrors the ⌥/ cycle (App.tsx) but jumps
  // straight to the picked agent: an empty chat flips in place; a started chat
  // clears + rebinds in the SAME tab (singleton model — the abandoned turn
  // persists to the history sidebar).
  const handleSwitchAgent = useCallback((next: SwitchableAgent) => {
    const chat = useChatStore.getState();
    const sess = chat.sessions[tabId];
    if ((sess?.agentType ?? "claude-code") === next) return;
    if ((sess?.messages.length ?? 0) === 0) {
      chat.actions.switchChatAgent(tabId, next);
    } else {
      chat.actions.clearSession(tabId);
      chat.actions.switchChatAgent(tabId, next);
    }
    window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
  }, [tabId]);

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

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      const t = slashTriggerRef.current;
      const view = inputRef.current?.view();
      if (!t || !view) return;

      if (cmd.handler === "atlas-login" || cmd.handler === "codex-login") {
        // `/login` doesn't pass through to the agent — open Atlas's own sign-in
        // dialog (Claude's setup dialog, or the Codex auth modal).
        clearSlashRange(view, t.from, t.to);
        setSlashTrigger(null);
        if (cmd.handler === "codex-login") setCodexLoginOpen(true);
        else openLoginDialog();
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

      // No required args — fire and forget. Clear the composer (the
      // user's `/query` doesn't need to linger) and dispatch via the
      // panel's normal send path.
      clearSlashRange(view, t.from, t.to);
      inputRef.current?.clear();
      setValue("");
      setSlashTrigger(null);
      onSend(`/${cmd.name}`, []);
    },
    [openLoginDialog, onSend, disabled]
  );

  // Forward Up/Down/Enter/Esc/Backspace from CodeMirror to whichever
  // picker is open. Slash and mention pickers are mutually exclusive in
  // practice (slash only fires at line start of an otherwise-empty
  // composer), but we still route deterministically.
  const keyInterceptor = useCallback(
    (key: "Up" | "Down" | "Enter" | "Escape" | "Backspace") => {
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
      }
    },
    []
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
    const text = inputRef.current?.getValue() ?? value;
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
    // The value→draft sync effect will collapse the empty value into a
    // `delete s.drafts[tabId]` on the next commit, so no explicit
    // clearDraft call is needed.
  }, [value, running, onSend, onStop, enqueueMessage, tabId, disabled, stagedImages, githubSyncing]);

  const trimmed = value.trim();
  // Tri-state button:
  //   running + empty   → STOP
  //   running + text    → QUEUE
  //   not running + any → SEND
  type Mode = "send" | "queue" | "stop";
  const mode: Mode = running ? (trimmed ? "queue" : "stop") : "send";
  const buttonEnabled = disabled
    ? false
    : mode === "stop"
      ? true
      : trimmed.length > 0;

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
        <PlanDock tabId={tabId} />

        <div
          ref={composerRef}
          data-chat-composer
          className={cn(
            // `z-10` so the composer paints over — and visually tucks — the
            // PlanDock's bottom edge (the attached-panel recipe).
            "relative z-10 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]",
            "shadow-[0_8px_24px_rgba(0,0,0,0.35)]",
            // Soft macOS-style "active field" glow on focus — a faint
            // accent ring on top of the border shift (the border alone is
            // near-invisible against the black surface).
            "transition-[border-color,box-shadow] duration-150",
            "focus-within:border-[var(--border-focus)]",
            "focus-within:ring-1 focus-within:ring-[var(--accent-primary)]/20",
            // Drag-over highlight: a clear accent ring while OS files hover.
            isDropTarget &&
              "border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]/40",
            // Hard-disable when Claude Code isn't ready. `pointer-events-none`
            // disables the textarea (no click-to-focus/type) and also blocks
            // the focus event so we never trigger the agent-bind listener
            // (which would try to spawn a session against a CLI that isn't
            // ready). Just dim it — no red tint — since the send button is
            // already disabled and submit()/Cmd+Enter are gated on `disabled`.
            disabled && "opacity-60 pointer-events-none",
            // Lock the composer while a GitHub repo syncs into `.atlas/repos`.
            githubSyncing !== null && "opacity-60 pointer-events-none",
          )}
          onFocusCapture={handleFocusCapture}
        >
          {githubSyncing !== null && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[var(--bg-base)]/40 backdrop-blur-[1px]">
              <span className="flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)] shadow">
                <Loader2 size={12} className="animate-spin" />
                Syncing {githubSyncing}…
              </span>
            </div>
          )}
          {isDropTarget && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[var(--accent-primary)]/8 backdrop-blur-[1px]">
              <span className="rounded-full bg-[var(--bg-elevated)] px-3 py-1 text-[11px] font-medium text-[var(--text-secondary)] shadow">
                Drop files to attach
              </span>
            </div>
          )}
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
                      onClick={() =>
                        setStagedImages((prev) => prev.filter((_, j) => j !== i))
                      }
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
          {LazyChatInput ? (
            <LazyChatInput
              ref={inputRef}
              initialValue={value}
              placeholder={effectivePlaceholder}
              onChange={setValue}
              onSubmit={submit}
              enterToSend={enterToSend}
              onMentionTrigger={setTrigger}
              onSlashTrigger={setSlashTrigger}
              onPasteImages={handlePasteImages}
              keyInterceptor={keyInterceptor}
              // All agents (incl. the native Atlas/cersei agent) support skills
              // now — the `#` rail inlines a skill body via compose_prompt, and the
              // native agent additionally loads Atlas-enabled skills via its Skill
              // tool. (`agentType` retained for other per-agent gating above.)
              allowSkillMention={true}
            />
          ) : (
            // Same-height empty slot so the panel layout doesn't reflow when
            // CodeMirror lands. Non-interactive — by the time the user can
            // visually find this region the chunk has typically resolved.
            <div
              aria-hidden="true"
              style={{ minHeight: 44 }}
              className="px-4 pt-3 pb-1"
            />
          )}
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-1">
              <ComposerAddMenu
                disabled={disabled || githubSyncing !== null}
                projectPath={useProjectStore.getState().currentProject?.path ?? null}
                agentId={switchableAgent}
                imageSupported={imageSupported}
                onAddFilesOrPhotos={() => void pickFilesOrPhotos()}
                onAttachMedia={() => void pickMedia()}
                onTakeScreenshot={(mode) => void handleTakeScreenshot(mode)}
                onPickSkill={handlePickSkill}
                onCloneRepo={(repo) => void handleCloneRepo(repo)}
                onPickSession={handlePickSession}
                onPickWorkspace={handlePickWorkspace}
                currentAgent={switchableAgent}
                onSwitchAgent={handleSwitchAgent}
              />
              {/* Which coding agent this chat is bound to (Claude / Codex).
                  Switch with ⌥/ (only on a fresh chat). */}
              <span
                className="flex items-center gap-1.5 px-1.5 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] select-none"
                title="Coding agent (switch with ⌥/ on a new chat)"
              >
                <AgentMark agentType={agentType} className="!h-4 !w-4 !text-[9px] !rounded" />
                {AGENT_LABEL[switchableAgent]}
              </span>
              {agentType === "claude-code" && (
              <button
                onClick={() => cycleClaudePermissionMode(tabId)}
                className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                title="Cycle permission mode (⇧⇥)"
              >
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full shrink-0",
                    permissionMode === "default" && "bg-[var(--text-tertiary)]",
                    permissionMode === "acceptEdits" && "bg-[var(--status-success)]",
                    permissionMode === "plan" && "bg-[var(--accent-primary)]",
                    permissionMode === "bypassPermissions" && "bg-[var(--status-error)]"
                  )}
                />
                {CLAUDE_PERMISSION_MODE_LABEL[permissionMode]}
              </button>
              )}
              {agentType !== "claude-code" && (hasAcpModes || acpModesPending) && (
                <AcpModePicker tabId={tabId} />
              )}
              {/* ACP first-party model picker — Claude Code / Codex advertise
                  their models in `session/new` (the native agent uses the BYOK
                  ProviderModelPills below instead). Renders nothing if empty. */}
              {agentType !== "cersei" && <AcpModelPicker tabId={tabId} />}
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

            <div className="flex items-center">
              <button
                onClick={submit}
                disabled={!buttonEnabled}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full transition-colors",
                  buttonEnabled
                    ? "bg-[var(--text-primary)] text-[var(--bg-primary)] hover:bg-[var(--text-secondary)] cursor-pointer"
                    : "bg-[var(--bg-elevated)] text-[var(--text-tertiary)] cursor-not-allowed"
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
                {mode === "stop" ? (
                  <Square
                    size={11}
                    strokeWidth={3}
                    fill="currentColor"
                    className={stopping ? "animate-pulse" : undefined}
                  />
                ) : (
                  <ArrowUp size={14} strokeWidth={2.5} />
                )}
              </button>
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
          // Per-agent skill gating: the `#` rail only lists skills enabled for
          // the active agent (registry ids "claude-code" / "codex" match agentType).
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
          footerLabel={agentType === "codex" ? "Codex commands" : undefined}
        />
      )}
      <CodexLoginDialog open={codexLoginOpen} onOpenChange={setCodexLoginOpen} />
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
