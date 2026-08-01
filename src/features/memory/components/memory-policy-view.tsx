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
import { useProjectStore } from "@/features/project/stores/project-store";
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
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
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
  const [originF, setOriginF] = useState<"all" | "preference" | "codebase">(
    "all",
  );
  const [query, setQuery] = useState("");
  const visible = policies.filter(
    (p) =>
      (matchF === "all" || p.match_kind === matchF) &&
      (strengthF === "all" || p.category === strengthF) &&
      (originF === "all" || p.origin === originF) &&
      (query.trim() === "" ||
        `${p.key} ${p.value}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
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
          <Loader2
            size={18}
            className="animate-spin text-[var(--text-tertiary)] mx-auto"
          />
          <p className="text-[11px] text-[var(--text-tertiary)]">
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
          <div className="w-12 h-12 mx-auto rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] flex items-center justify-center">
            <Sparkles size={22} className="text-[var(--text-secondary)]" />
          </div>
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            Enable preference learning
          </p>
          <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            Download the on-device embedding model to distill your saved
            preferences into an editable policy table — no LLM, purely semantic.
          </p>
          <button
            onClick={() => void download()}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-[var(--accent-primary)] text-[var(--bg-base)] text-[11px] font-medium hover:opacity-90 transition-opacity cursor-pointer"
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
          ((progress.file_index +
            (progress.total ? progress.received / progress.total : 0)) /
            Math.max(1, progress.file_count)) *
            100,
        )
      : 0;
    return (
      <Centered>
        <div className="text-center max-w-[360px] px-6 w-full space-y-2">
          <Loader2
            size={20}
            className="animate-spin text-[var(--text-secondary)] mx-auto"
          />
          <p className="text-[12px] text-[var(--text-primary)]">
            Downloading model…
          </p>
          <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent-primary)] transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[10px] text-[var(--text-tertiary)] font-mono">
            {pct}%
          </p>
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
            className="text-[var(--status-error)] mx-auto"
          />
          <p className="text-[12px] text-[var(--text-secondary)]">
            Couldn't load policies
          </p>
          {error && (
            <p className="text-[10px] text-[var(--text-tertiary)] font-mono break-words">
              {error}
            </p>
          )}
          <button
            onClick={() => void init(projectPath)}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <RotateCw size={12} /> Retry
          </button>
        </div>
      </Centered>
    );
  }

  // phase === "ready"
  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)]">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          Preferences
          <span className="ml-1.5 text-[9px] text-[var(--text-tertiary)] tabular-nums">
            {policies.length}
          </span>
        </span>
        <div className="flex-1" />
        <button
          onClick={() => void loadPolicies(projectPath, true)}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Re-scan preferences"
        >
          <RotateCw size={12} />
        </button>
      </div>

      {policies.length === 0 ? (
        <Centered>
          <p className="text-[12px] text-[var(--text-tertiary)] max-w-[300px] text-center px-4">
            No preferences detected yet. As Claude Code & Codex record how you
            like to work, they'll surface here.
          </p>
        </Centered>
      ) : (
        <>
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 shrink-0 border-b border-[var(--border-subtle)]">
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
              className="ml-auto h-[22px] w-[130px] rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-focus)]"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
            <div style={{ minWidth: TABLE_MIN_W }}>
              <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border-default)] bg-[var(--bg-base)] px-3 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                <span className={COL.policy}>Policy</span>
                <span className={COL.value}>Value</span>
                <span className={COL.source}>Source</span>
                <span className={cn(COL.score, "text-right")}>Match</span>
                <span className={COL.actions} />
              </div>
              {visible.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] text-[var(--text-tertiary)]">
                  No policies match these filters.
                </div>
              ) : (
                visible.map((p) => (
                  <PolicyRow key={p.id} policy={p} onSaved={onSaved} />
                ))
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
    <div className="flex items-center gap-0.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "h-[18px] rounded px-1.5 text-[10px] transition-colors cursor-pointer",
            value === v
              ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
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
      toast.error(
        `Couldn't update: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center min-h-[42px] px-3 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]/40 transition-colors">
      <div className={cn(COL.policy, "pr-3 min-w-0")}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-[8.5px] font-semibold uppercase tracking-wide border",
              policy.category === "strong"
                ? "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]"
                : "border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)]",
            )}
            title={
              policy.category === "strong"
                ? "Strong rule — must follow"
                : "Soft preference — guidance"
            }
          >
            {policy.category}
          </span>
          <span className="text-[12px] text-[var(--text-primary)] truncate">
            {policy.key}
          </span>
        </div>
        <div className="text-[10px] text-[var(--text-tertiary)] truncate mt-0.5">
          {policy.hint}
        </div>
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
            "w-full bg-transparent outline-none text-[12px] text-[var(--text-secondary)] rounded px-1.5 py-1 border transition-colors",
            dirty
              ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
              : "border-transparent hover:border-[var(--border-default)]",
          )}
        />
      </div>

      <div className={cn(COL.source, "flex items-center gap-1.5 min-w-0")}>
        {policy.source === "codex" ? (
          <CodexIcon className="size-3 shrink-0 opacity-70" />
        ) : (
          <ClaudeIcon className="size-3 shrink-0 opacity-70" />
        )}
        <span
          className="text-[10px] text-[var(--text-tertiary)] truncate"
          title={policy.file_path}
        >
          {basename(policy.file_path)}
        </span>
      </div>

      <div
        className={cn(
          COL.score,
          "text-right tabular-nums text-[10px] text-[var(--text-tertiary)]",
        )}
      >
        {Math.round(policy.score * 100)}%
      </div>

      <div className={cn(COL.actions, "flex items-center justify-end gap-0.5")}>
        {dirty ? (
          <>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="flex items-center justify-center w-5 h-5 rounded text-[var(--status-success,#4d4d4d)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              title="Save (Enter)"
            >
              {saving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Check size={13} />
              )}
            </button>
            <button
              onClick={() => setDraft(policy.value)}
              className="flex items-center justify-center w-5 h-5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              title="Revert (Esc)"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <button
            onClick={() =>
              sendToAgentChat(`Preference — ${policy.key}: ${policy.value}`)
            }
            className="flex items-center justify-center w-5 h-5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            title="Send to agent chat"
          >
            <MessageSquarePlus size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-[var(--text-tertiary)] text-[12px]">
      {children}
    </div>
  );
}
