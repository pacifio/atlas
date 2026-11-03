import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Download,
  Sparkles,
  RotateCw,
  Check,
  X,
  MessageSquarePlus,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton, iconButtonVariants } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { useAppStore } from "@/features/app/stores/app-store";
import { sendToAgentChat } from "@/features/chat/lib/send-to-agent";
import { ClaudeIcon, CodexIcon } from "@/components/agent-icons";
import { memoryPolicy, type Policy } from "../lib/memory-policy-api";
import {
  memoryGraph,
  listenMemoryEmbedProgress,
  listenMemoryEmbedDone,
  type DownloadProgress,
} from "../lib/memory-graph-api";
import { useMemoryStore } from "../stores/memory-store";
import {
  CountPill,
  Notice,
  ProgressBar,
  TABLE_HEAD,
  TABLE_ROW,
  Toolbar,
  Track,
  TrackSegment,
} from "./views/memory-chrome";

// Column tracks shared by header + rows (mirrors the BYOK / Codex tables).
const COL = {
  policy: "w-[180px] shrink-0",
  value: "flex-1 min-w-[280px]",
  source: "w-[150px] shrink-0",
  score: "w-[64px] shrink-0",
  actions: "w-[40px] shrink-0",
} as const;
const TABLE_MIN_W = 180 + 280 + 150 + 64 + 40;

export function MemoryPolicyView() {
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  // Cached in the module-level memory store so jumping sub-tabs / leaving and
  // returning doesn't re-run the (expensive) policy indexing.
  const phase = useMemoryStore.use.policyPhase();
  const policies = useMemoryStore.use.policies() ?? [];
  const error = useMemoryStore.use.policyError();
  const {
    ensureProject,
    loadPolicies: storeLoadPolicies,
    setPolicyPhase,
    updatePolicyValue,
  } = useMemoryStore.use.actions();
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  // ── Filters ──────────────────────────────────────────────────────────────
  const [matchF, setMatchF] = useState<"all" | "semantic" | "keyword">("all");
  const [strengthF, setStrengthF] = useState<"all" | "soft" | "strong">("all");
  const [originF, setOriginF] = useState<"all" | "preference" | "codebase">("all");
  const [query, setQuery] = useState("");
  const visible = policies.filter(
    (p) =>
      (matchF === "all" || p.match_kind === matchF) &&
      (strengthF === "all" || p.category === strengthF) &&
      (originF === "all" || p.origin === originF) &&
      (query.trim() === "" ||
        `${p.key} ${p.value}`.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const loadPolicies = useCallback(
    (pp: string, force = false) => storeLoadPolicies(pp, force),
    [storeLoadPolicies],
  );

  const init = useCallback(
    async (pp: string) => {
      setPolicyPhase("checking");
      try {
        const status = await memoryGraph.embedStatus();
        if (status.downloaded) await storeLoadPolicies(pp);
        else setPolicyPhase("not-downloaded");
      } catch (e) {
        setPolicyPhase("error", String(e));
      }
    },
    [storeLoadPolicies, setPolicyPhase],
  );

  useEffect(() => {
    ensureProject(projectPath);
    if (!projectPath) return;
    const st = useMemoryStore.getState();
    // Optimistic: cached + ready → render instantly, no re-index. Mid-download →
    // leave it. Otherwise check status + load.
    if (st.policies && st.policyPhase === "ready") return;
    if (st.policyPhase === "downloading") return;
    void init(projectPath);
  }, [projectPath, ensureProject, init]);

  const download = useCallback(async () => {
    setPolicyPhase("downloading");
    setProgress(null);
    const unlistens = [
      await listenMemoryEmbedProgress((p) => setProgress(p)),
      await listenMemoryEmbedDone((d) => {
        unlistens.forEach((u) => u());
        if (d.success && projectPath) void storeLoadPolicies(projectPath, true);
        else setPolicyPhase("error", d.error ?? "Download failed");
      }),
    ];
    try {
      await memoryGraph.embedDownload();
    } catch (e) {
      unlistens.forEach((u) => u());
      setPolicyPhase("error", String(e));
    }
  }, [projectPath, storeLoadPolicies, setPolicyPhase]);

  const onSaved = updatePolicyValue;

  if (!projectPath) return <Notice>Open a project first.</Notice>;

  if (phase === "idle" || phase === "checking" || phase === "loading") {
    return (
      <Notice icon={<Loader2 size={18} className="animate-spin" />}>
        {phase === "loading" ? "Distilling preferences…" : "Checking…"}
      </Notice>
    );
  }

  if (phase === "not-downloaded") {
    return (
      <Notice
        icon={<Sparkles size={20} />}
        title="Enable preference learning"
        action={
          <Button size="lg" onClick={() => void download()}>
            <Download size={13} />
            Download model
          </Button>
        }
      >
        Download the on-device embedding model to distill your saved preferences into an editable
        policy table — no LLM, purely semantic.
      </Notice>
    );
  }

  if (phase === "downloading") {
    const pct = progress
      ? Math.round(
          ((progress.file_index + (progress.total ? progress.received / progress.total : 0)) /
            Math.max(1, progress.file_count)) *
            100,
        )
      : 0;
    return (
      <Notice icon={<Loader2 size={18} className="animate-spin" />} title="Downloading model…">
        <div className="flex w-[320px] max-w-full flex-col gap-2 pt-1">
          <ProgressBar pct={pct} />
          <p className="font-mono text-2xs tabular-nums">{pct}%</p>
        </div>
      </Notice>
    );
  }

  if (phase === "error") {
    return (
      <Notice
        icon={<AlertTriangle size={18} className="text-error" />}
        title="Couldn't load policies"
        action={
          <Button variant="outline" onClick={() => void init(projectPath)}>
            <RotateCw size={12} /> Retry
          </Button>
        }
      >
        {error && <p className="font-mono text-2xs break-words">{error}</p>}
      </Notice>
    );
  }

  // phase === "ready"
  return (
    <div className="flex h-full flex-col bg-background">
      {/* One toolbar: title, count and re-scan, then the filters. It used to
          be two stacked strips, a title row and then the filters under it;
          the order is unchanged, so focus still moves re-scan → filters. */}
      <Toolbar className="gap-3">
        <span className="label flex items-center gap-1.5">
          Preferences
          <CountPill count={policies.length} />
        </span>
        <Hint label="Re-scan preferences">
          <IconButton
            icon={RotateCw}
            label="Re-scan preferences"
            size="sm"
            className="-ml-2"
            onClick={() => void loadPolicies(projectPath, true)}
          />
        </Hint>
        {policies.length > 0 && (
          <>
            <FilterGroup
              value={originF}
              onChange={setOriginF}
              options={
                [
                  ["all", "All"],
                  ["preference", "Preferences"],
                  ["codebase", "Codebase"],
                ] as const
              }
            />
            <FilterGroup
              value={matchF}
              onChange={setMatchF}
              options={
                [
                  ["all", "Any match"],
                  ["semantic", "Semantic"],
                  ["keyword", "Keyword"],
                ] as const
              }
            />
            <FilterGroup
              value={strengthF}
              onChange={setStrengthF}
              options={
                [
                  ["all", "Any"],
                  ["soft", "Soft"],
                  ["strong", "Strong"],
                ] as const
              }
            />
          </>
        )}
        <div className="flex-1" />
        {policies.length > 0 && (
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="w-[160px]"
          />
        )}
      </Toolbar>

      {policies.length === 0 ? (
        <Notice>
          No preferences detected yet. As Claude Code & Codex record how you like to work, they'll
          surface here.
        </Notice>
      ) : (
        <>
          <div className="hide-scrollbar min-h-0 flex-1 overflow-auto">
            <div style={{ minWidth: TABLE_MIN_W }}>
              <div className={TABLE_HEAD}>
                <span className={COL.policy}>Policy</span>
                <span className={COL.value}>Value</span>
                <span className={COL.source}>Source</span>
                <span className={cn(COL.score, "text-right")}>Match</span>
                <span className={COL.actions} />
              </div>
              {visible.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No policies match these filters.
                </div>
              ) : (
                visible.map((p) => <PolicyRow key={p.id} policy={p} onSaved={onSaved} />)
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Compact segmented filter (origin / match type / strength). */
function FilterGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <Track>
      {options.map(([v, label]) => (
        <TrackSegment key={v} active={value === v} onClick={() => onChange(v)}>
          {label}
        </TrackSegment>
      ))}
    </Track>
  );
}

function PolicyRow({
  policy,
  onSaved,
}: {
  policy: Policy;
  onSaved: (id: string, value: string) => void;
}) {
  const [draft, setDraft] = useState(policy.value);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== policy.value;

  useEffect(() => {
    setDraft(policy.value);
  }, [policy.value]);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await memoryPolicy.update(policy.file_path, policy.value, draft);
      onSaved(policy.id, draft);
      toast.success(`${policy.key} updated`);
    } catch (e) {
      toast.error(`Couldn't update: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        TABLE_ROW,
        "flex min-h-[44px] items-center px-3 transition-colors duration-fast hover:bg-element-hover",
      )}
    >
      <div className={cn(COL.policy, "min-w-0 pr-3")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge
            size="sm"
            variant={policy.category === "strong" ? "destructive" : "outline"}
            title={
              policy.category === "strong"
                ? "Strong rule — must follow"
                : "Soft preference — guidance"
            }
          >
            <span className="font-semibold uppercase tracking-wide">{policy.category}</span>
          </Badge>
          <span className="truncate text-sm font-medium text-foreground">{policy.key}</span>
        </div>
        <div className="caption mt-0.5 truncate">{policy.hint}</div>
      </div>

      <div className={cn(COL.value, "pr-3")}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            else if (e.key === "Escape") setDraft(policy.value);
          }}
          spellCheck={false}
          className={cn(
            "h-control-md w-full rounded border bg-transparent px-2 text-sm outline-none",
            "transition-colors duration-fast ease-out-strong",
            dirty
              ? "border-border-strong bg-panel-input text-foreground"
              : "border-transparent text-secondary-foreground hover:border-border focus:border-border-strong",
          )}
        />
      </div>

      <div className={cn(COL.source, "flex min-w-0 items-center gap-1.5")}>
        {policy.source === "codex" ? (
          <CodexIcon className="size-3 shrink-0 opacity-70" />
        ) : (
          <ClaudeIcon className="size-3 shrink-0 opacity-70" />
        )}
        <span className="caption truncate font-mono" title={policy.file_path}>
          {basename(policy.file_path)}
        </span>
      </div>

      <div className={cn(COL.score, "caption text-right tabular-nums")}>
        {Math.round(policy.score * 100)}%
      </div>

      <HintGroup>
        <div className={cn(COL.actions, "flex items-center justify-end gap-0.5")}>
          {dirty ? (
            <>
              <HintItem label="Save (Enter)">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className={ROW_ACTION}
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                </button>
              </HintItem>
              <HintItem label="Revert (Esc)">
                <button type="button" onClick={() => setDraft(policy.value)} className={ROW_ACTION}>
                  <X size={12} />
                </button>
              </HintItem>
            </>
          ) : (
            <HintItem label="Send to a session">
              <button
                type="button"
                onClick={() => sendToAgentChat(`Preference — ${policy.key}: ${policy.value}`)}
                className={ROW_ACTION}
              >
                <MessageSquarePlus size={12} />
              </button>
            </HintItem>
          )}
        </div>
      </HintGroup>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/** A row's glyph action: `IconButton`'s ghost square on a plain button, so the
 *  save glyph can swap to its spinner in place. */
const ROW_ACTION = iconButtonVariants({ size: "xs" });
