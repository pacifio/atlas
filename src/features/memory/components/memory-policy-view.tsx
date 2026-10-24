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

  if (!projectPath) return <Centered>Open a project first.</Centered>;

  if (phase === "idle" || phase === "checking" || phase === "loading") {
    return (
      <Centered>
        <div className="text-center space-y-2">
          <Loader2 size={18} className="animate-spin text-[var(--muted-foreground)] mx-auto" />
          <p className="text-xs text-[var(--muted-foreground)]">
            {phase === "loading" ? "Distilling preferences…" : "Checking…"}
          </p>
        </div>
      </Centered>
    );
  }

  if (phase === "not-downloaded") {
    return (
      <Centered>
        <div className="text-center max-w-[360px] px-6 space-y-3">
          <div className="w-12 h-12 mx-auto rounded-xl bg-[var(--card)] border border-[var(--border)] flex items-center justify-center">
            <Sparkles size={22} className="text-[var(--secondary-foreground)]" />
          </div>
          <p className="text-base font-medium text-[var(--foreground)]">
            Enable preference learning
          </p>
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            Download the on-device embedding model to distill your saved preferences into an
            editable policy table — no LLM, purely semantic.
          </p>
          <button
            onClick={() => void download()}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-[var(--primary)] text-[var(--background)] text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
          >
            <Download size={13} />
            Download model
          </button>
        </div>
      </Centered>
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
      <Centered>
        <div className="text-center max-w-[360px] px-6 w-full space-y-2">
          <Loader2 size={20} className="animate-spin text-[var(--secondary-foreground)] mx-auto" />
          <p className="text-sm text-[var(--foreground)]">Downloading model…</p>
          <div className="h-1.5 rounded-full bg-[var(--card)] overflow-hidden">
            <div
              className="h-full bg-[var(--primary)] transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-2xs text-[var(--muted-foreground)] font-mono">{pct}%</p>
        </div>
      </Centered>
    );
  }

  if (phase === "error") {
    return (
      <Centered>
        <div className="text-center max-w-[340px] px-6 space-y-3">
          <AlertTriangle
            size={20}
            className="text-[var(--atlas-status-error-foreground)] mx-auto"
          />
          <p className="text-sm text-[var(--secondary-foreground)]">Couldn't load policies</p>
          {error && (
            <p className="text-2xs text-[var(--muted-foreground)] font-mono break-words">{error}</p>
          )}
          <button
            onClick={() => void init(projectPath)}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-[var(--border)] text-xs text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
          >
            <RotateCw size={12} /> Retry
          </button>
        </div>
      </Centered>
    );
  }

  // phase === "ready"
  return (
    <div className="h-full flex flex-col bg-[var(--background)]">
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--secondary-foreground)]">
          Preferences
          <span className="ml-1.5 text-3xs text-[var(--muted-foreground)] tabular-nums">
            {policies.length}
          </span>
        </span>
        <div className="flex-1" />
        <Hint label="Re-scan preferences">
          <button
            onClick={() => void loadPolicies(projectPath, true)}
            className="flex items-center justify-center w-6 h-6 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] transition-colors cursor-pointer"
          >
            <RotateCw size={12} />
          </button>
        </Hint>
      </div>

      {policies.length === 0 ? (
        <Centered>
          <p className="text-sm text-[var(--muted-foreground)] max-w-[300px] text-center px-4">
            No preferences detected yet. As Claude Code & Codex record how you like to work, they'll
            surface here.
          </p>
        </Centered>
      ) : (
        <>
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 shrink-0 border-b border-[var(--atlas-border-subtle)]">
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
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="ml-auto h-[22px] w-[130px] rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--atlas-border-strong)]"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
            <div style={{ minWidth: TABLE_MIN_W }}>
              <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border)] bg-[var(--background)] px-3 text-2xs uppercase tracking-wider text-[var(--muted-foreground)]">
                <span className={COL.policy}>Policy</span>
                <span className={COL.value}>Value</span>
                <span className={COL.source}>Source</span>
                <span className={cn(COL.score, "text-right")}>Match</span>
                <span className={COL.actions} />
              </div>
              {visible.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
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
    <div className="flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--card)] p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "h-[18px] rounded px-1.5 text-2xs transition-colors cursor-pointer",
            value === v
              ? "bg-[var(--atlas-element-selected)] text-[var(--foreground)]"
              : "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
          )}
        >
          {label}
        </button>
      ))}
    </div>
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
    <div className="flex items-center min-h-[42px] px-3 border-b border-[var(--atlas-border-subtle)] hover:bg-[var(--atlas-element-hover)]/40 transition-colors">
      <div className={cn(COL.policy, "pr-3 min-w-0")}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-3xs font-semibold uppercase tracking-wide border",
              policy.category === "strong"
                ? "border-[var(--atlas-status-error-foreground)]/40 bg-[var(--atlas-status-error-foreground)]/10 text-[var(--atlas-status-error-foreground)]"
                : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]",
            )}
            title={
              policy.category === "strong"
                ? "Strong rule — must follow"
                : "Soft preference — guidance"
            }
          >
            {policy.category}
          </span>
          <span className="text-sm text-[var(--foreground)] truncate">{policy.key}</span>
        </div>
        <div className="text-2xs text-[var(--muted-foreground)] truncate mt-0.5">{policy.hint}</div>
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
            "w-full bg-transparent outline-none text-sm text-[var(--secondary-foreground)] rounded px-1.5 py-1 border transition-colors",
            dirty
              ? "border-[var(--atlas-border-strong)] bg-[var(--card)] text-[var(--foreground)]"
              : "border-transparent hover:border-[var(--border)]",
          )}
        />
      </div>

      <div className={cn(COL.source, "flex items-center gap-1.5 min-w-0")}>
        {policy.source === "codex" ? (
          <CodexIcon className="size-3 shrink-0 opacity-70" />
        ) : (
          <ClaudeIcon className="size-3 shrink-0 opacity-70" />
        )}
        <span className="text-2xs text-[var(--muted-foreground)] truncate" title={policy.file_path}>
          {basename(policy.file_path)}
        </span>
      </div>

      <div
        className={cn(COL.score, "text-right tabular-nums text-2xs text-[var(--muted-foreground)]")}
      >
        {Math.round(policy.score * 100)}%
      </div>

      <HintGroup>
        <div className={cn(COL.actions, "flex items-center justify-end gap-0.5")}>
          {dirty ? (
            <>
              <HintItem label="Save (Enter)">
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="flex items-center justify-center w-5 h-5 rounded text-success hover:text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] disabled:opacity-50"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
                </button>
              </HintItem>
              <HintItem label="Revert (Esc)">
                <button
                  onClick={() => setDraft(policy.value)}
                  className="flex items-center justify-center w-5 h-5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)]"
                >
                  <X size={12} />
                </button>
              </HintItem>
            </>
          ) : (
            <HintItem label="Send to a session">
              <button
                onClick={() => sendToAgentChat(`Preference — ${policy.key}: ${policy.value}`)}
                className="flex items-center justify-center w-5 h-5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] transition-colors"
              >
                <MessageSquarePlus size={13} />
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-[var(--muted-foreground)] text-sm">
      {children}
    </div>
  );
}
