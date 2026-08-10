import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { openFile } from "@/lib/open-file";
import { Markdown } from "@/lib/markdown";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { sendToAgentChat } from "@/features/chat/lib/send-to-agent";
import { providerById } from "@/features/settings/lib/providers";
import { ProviderLogo } from "@/components/provider-logo";
import { useReviewStore } from "../stores/review-store";
import { ReportView, FileCard } from "./verdict-cards";
import { Combobox, type ComboOption } from "./combobox";
import {
  review,
  reportToMarkdown,
  fileToMarkdown,
  type FileVerdict,
  type ReviewRecord,
} from "../lib/review-api";
import {
  Play,
  Square,
  Loader2,
  CheckCheck,
  ChevronLeft,
  KeyRound,
  Link as LinkIcon,
} from "lucide-react";

interface GitLogEntry {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
}

type SourceMode = "working" | "staged" | "commit" | "branch";

export function ReviewAgentsPanel() {
  const project = useProjectStore.use.currentProject();
  const projectPath = project?.path ?? null;

  const providers = useReviewStore.use.providers();
  const providersLoaded = useReviewStore.use.providersLoaded();
  const selectedProvider = useReviewStore.use.selectedProvider();
  const models = useReviewStore.use.models();
  const loadingModels = useReviewStore.use.loadingModels();
  const selectedModel = useReviewStore.use.selectedModel();
  const records = useReviewStore.use.records();
  const selectedRecord = useReviewStore.use.selectedRecord();
  const streaming = useReviewStore.use.streaming();
  const streamError = useReviewStore.use.streamError();
  const pendingSource = useReviewStore.use.pendingSource();
  const actions = useReviewStore.use.actions();
  // Configured BYOK keys — drives a live refresh of the provider picker when a
  // key is added/removed in Settings while this panel is open.
  const byokKeys = useByokStore.use.keys();

  const [mode, setMode] = useState<SourceMode>("working");
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [bases, setBases] = useState<string[]>([]);
  const [baseSel, setBaseSel] = useState<string | null>(null);

  useEffect(() => {
    if (projectPath) void actions.init(projectPath);
  }, [projectPath, actions]);

  // React to BYOK key add/remove in Settings: refresh the usable providers
  // (and switch off a provider whose key was just deleted). Skip the first run
  // since `init` already loaded providers.
  const byokFirstRef = useRef(true);
  useEffect(() => {
    if (byokFirstRef.current) {
      byokFirstRef.current = false;
      return;
    }
    void actions.refreshProviders();
  }, [byokKeys, actions]);

  // Apply a source preset requested from elsewhere (Source Control).
  useEffect(() => {
    if (!pendingSource) return;
    setMode(pendingSource.mode);
    if (pendingSource.mode === "commit" && pendingSource.sha) {
      const sha = pendingSource.sha;
      setCommitSha(sha);
      setCommits((prev) =>
        prev.some((c) => c.hash === sha)
          ? prev
          : [
              {
                hash: sha,
                short_hash: sha.slice(0, 7),
                message: "(selected commit)",
                author: "",
                date: "",
              },
              ...prev,
            ],
      );
    }
    actions.consumePending();
  }, [pendingSource, actions]);

  // Lazily load commits when entering commit mode.
  useEffect(() => {
    if (mode !== "commit" || !projectPath || commits.length > 0) return;
    void invoke<GitLogEntry[]>("git_log", { path: projectPath, limit: 50 })
      .then((c) => {
        setCommits(c);
        if (c.length > 0) setCommitSha((s) => s ?? c[0].hash);
      })
      .catch(() => setCommits([]));
  }, [mode, projectPath, commits.length]);

  // Lazily load base branches when entering branch mode.
  useEffect(() => {
    if (mode !== "branch" || !projectPath || bases.length > 0) return;
    void review
      .baseBranches(projectPath)
      .then((b) => {
        setBases(b.branches);
        setBaseSel((s) => s ?? b.default ?? b.branches[0] ?? null);
      })
      .catch(() => setBases([]));
  }, [mode, projectPath, bases.length]);

  // Keep the store source in sync with the picker.
  useEffect(() => {
    actions.setSource(
      mode === "working"
        ? { type: "working" }
        : mode === "staged"
          ? { type: "staged" }
          : mode === "commit"
            ? { type: "commit", sha: commitSha ?? "" }
            : { type: "branch", base: baseSel },
    );
  }, [mode, commitSha, baseSel, actions]);

  const providerOptions: ComboOption[] = useMemo(
    () =>
      providers.map((p) => ({
        value: p,
        label: providerById(p)?.name ?? p,
        icon: <ProviderLogo id={p} size={14} />,
      })),
    [providers],
  );
  const modelOptions: ComboOption[] = useMemo(
    () => models.map((m) => ({ value: m, label: m })),
    [models],
  );
  const commitOptions: ComboOption[] = useMemo(
    () =>
      commits.map((c) => ({
        value: c.hash,
        label: c.message,
        hint: `${c.short_hash}${c.author ? ` · ${c.author}` : ""}`,
      })),
    [commits],
  );
  const baseOptions: ComboOption[] = useMemo(
    () => bases.map((b) => ({ value: b, label: b })),
    [bases],
  );

  const onOpenIssue = (relativeFile: string) => {
    if (!projectPath) return;
    const full = relativeFile.startsWith("/") ? relativeFile : `${projectPath}/${relativeFile}`;
    openFile(full);
  };

  const onShareFile = (file: FileVerdict) => sendToAgentChat(fileToMarkdown(file));

  const canRun =
    !!projectPath &&
    !!selectedProvider &&
    !!selectedModel &&
    !streaming &&
    (mode !== "commit" || !!commitSha);

  if (!projectPath) {
    return <Empty label="Open a project to review changes." />;
  }

  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[var(--panel-bg)] text-[11px]">
      {/* Controls */}
      <div className="border-b border-border-default p-2 flex flex-col gap-2 shrink-0">
        <div className="flex gap-0.5">
          {(["working", "staged", "commit", "branch"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={streaming}
              className={cn(
                "flex-1 px-1.5 py-1 rounded capitalize transition-colors cursor-pointer disabled:opacity-50",
                mode === m
                  ? "bg-bg-selected text-text-primary"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === "commit" && (
          <Combobox
            value={commitSha}
            options={commitOptions}
            onChange={setCommitSha}
            placeholder="Select a commit"
            emptyLabel="No commits"
            disabled={streaming}
          />
        )}
        {mode === "branch" && (
          <Combobox
            value={baseSel}
            options={baseOptions}
            onChange={setBaseSel}
            placeholder="Base branch (auto)"
            emptyLabel="Detecting…"
            disabled={streaming}
          />
        )}

        {providersLoaded && providers.length === 0 ? (
          <div className="flex items-start gap-1.5 text-text-tertiary rounded border border-border-default bg-bg-selected/20 p-2">
            <KeyRound size={12} className="mt-0.5 shrink-0" />
            <span>No API keys configured. Add one in Settings → API keys to run reviews.</span>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Combobox
              value={selectedProvider}
              options={providerOptions}
              onChange={(v) => void actions.setProvider(v)}
              placeholder="Provider"
              disabled={streaming || providers.length === 0}
              className="flex-1"
            />
            <Combobox
              value={selectedModel}
              options={modelOptions}
              onChange={(v) => actions.setModel(v)}
              placeholder="Model"
              emptyLabel={loadingModels ? "Loading…" : "No models"}
              disabled={streaming || loadingModels || models.length === 0}
              className="flex-1"
            />
          </div>
        )}

        {streaming ? (
          <button
            onClick={() => actions.cancel()}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-[var(--status-error)]/15 text-[var(--status-error)] hover:bg-[var(--status-error)]/25 transition-colors cursor-pointer"
          >
            <Square size={12} /> Cancel review
          </button>
        ) : (
          <button
            onClick={() => projectPath && void actions.start(projectPath)}
            disabled={!canRun}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-bg-selected text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <Play size={12} /> Review
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        {streaming ? (
          <LiveProgress
            onOpenIssue={onOpenIssue}
            projectPath={projectPath}
            onShareFile={onShareFile}
          />
        ) : streamError ? (
          <div className="m-2 rounded border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-2 text-[var(--status-error)]">
            {streamError}
          </div>
        ) : selectedRecord ? (
          <RecordView
            record={selectedRecord}
            onOpenIssue={onOpenIssue}
            projectPath={projectPath}
            onShareFile={onShareFile}
            onBack={records.length > 0 ? () => actions.selectRecord(null) : undefined}
          />
        ) : (
          <RecordList records={records} onPick={(r) => actions.selectRecord(r)} />
        )}
      </div>
    </div>
  );
}

function LiveProgress({
  onOpenIssue,
  projectPath,
  onShareFile,
}: {
  onOpenIssue: (file: string, line?: number) => void;
  projectPath: string | null;
  onShareFile: (file: FileVerdict) => void;
}) {
  const pending = useReviewStore.use.pendingFiles();
  const liveFiles = useReviewStore.use.liveFiles();
  const synthesisText = useReviewStore.use.synthesisText();
  const fileErrors = useReviewStore.use.fileErrors();
  const done = liveFiles.length;
  const total = done + pending.length;

  return (
    <div className="p-2 flex flex-col gap-2 animate-fade-in">
      <div className="flex items-center gap-1.5 text-text-tertiary">
        <Loader2 size={12} className="animate-spin" />
        {synthesisText ? "Synthesizing report…" : `Reviewing files… (${done}/${total})`}
      </div>

      {pending.map((p) => (
        <div
          key={p}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-[var(--bg-elevated)]/30 px-2 py-1.5 text-text-tertiary"
        >
          <Loader2 size={11} className="animate-spin shrink-0" />
          <span className="truncate">{p.split("/").pop()}</span>
        </div>
      ))}

      {liveFiles.map((f) => (
        <FileCard
          key={f.path}
          file={f}
          onOpenIssue={onOpenIssue}
          projectPath={projectPath ?? undefined}
          onShare={onShareFile}
        />
      ))}

      {fileErrors.map((e, i) => (
        <div key={i} className="text-[10px] text-[var(--status-error)]/80 px-1">
          {e}
        </div>
      ))}

      {synthesisText && (
        <div className="rounded-lg border border-border-subtle bg-[var(--bg-elevated)]/50 p-2.5 mt-1">
          <Markdown className="text-[11px]">{synthesisText}</Markdown>
        </div>
      )}
    </div>
  );
}

function RecordView({
  record,
  onOpenIssue,
  projectPath,
  onShareFile,
  onBack,
}: {
  record: ReviewRecord;
  onOpenIssue: (file: string, line?: number) => void;
  projectPath: string | null;
  onShareFile: (file: FileVerdict) => void;
  onBack?: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border-default sticky top-0 bg-[var(--panel-bg)]/90 backdrop-blur-sm z-10">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-0.5 text-text-tertiary hover:text-text-secondary cursor-pointer"
          >
            <ChevronLeft size={12} /> Back
          </button>
        )}
        <span className="truncate text-[10px] text-text-tertiary">{record.title}</span>
        <button
          onClick={() => sendToAgentChat(reportToMarkdown(record))}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer shrink-0"
          title="Send this review to the coding agent"
        >
          <LinkIcon size={10} /> Share
        </button>
      </div>
      <ReportView
        report={record.report}
        onOpenIssue={onOpenIssue}
        projectPath={projectPath ?? undefined}
        onShareFile={onShareFile}
      />
    </div>
  );
}

function RecordList({
  records,
  onPick,
}: {
  records: ReviewRecord[];
  onPick: (r: ReviewRecord) => void;
}) {
  if (records.length === 0) {
    return <Empty label="No reviews yet. Pick a source and run one." />;
  }
  return (
    <div className="flex flex-col">
      {records.map((r) => (
        <button
          key={r.id}
          onClick={() => onPick(r)}
          className="text-left px-2 py-2 border-b border-border-subtle hover:bg-bg-hover transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            <CheckCheck size={12} className="text-text-tertiary shrink-0" />
            <span className="truncate text-text-primary">{r.title}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-tertiary">
            <span>{r.model}</span>
            {typeof r.report?.score === "number" && <span>· {r.report.score}/100</span>}
            <span>· {r.report?.files.length ?? 0} files</span>
            <span className="ml-auto">{relativeTime(r.createdAt)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center p-4 text-center text-text-tertiary text-[11px]">
      {label}
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
