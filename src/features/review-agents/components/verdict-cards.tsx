import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import {
  ChevronRight,
  FileWarning,
  Network,
  AlertTriangle,
  Link as LinkIcon,
  Archive,
  EyeOff,
} from "lucide-react";
import { MermaidBlock } from "./mermaid-block";
import type { FileVerdict, ReviewReport } from "../lib/review-api";

interface Props {
  report: ReviewReport;
  onOpenIssue: (relativeFile: string, line?: number) => void;
  /** Project root — enables per-file git actions (stash / ignore). */
  projectPath?: string;
  /** Share just one file's issues with the coding agent. */
  onShareFile?: (file: FileVerdict) => void;
}

/** Render a full review report: badges, architecture diagram, overview, and a
 *  per-file accordion. */
export function ReportView({
  report,
  onOpenIssue,
  projectPath,
  onShareFile,
}: Props) {
  const hasSecurity =
    report.security_concerns &&
    report.security_concerns.trim().toLowerCase() !== "no";

  return (
    <div className="flex flex-col gap-2.5 p-2.5 text-[11px] animate-fade-in">
      {/* Badges */}
      <div className="flex flex-wrap gap-1.5">
        {typeof report.score === "number" && (
          <Badge
            label="Score"
            value={`${report.score}/100`}
            tone={scoreTone(report.score)}
          />
        )}
        {typeof report.estimated_effort_to_review === "number" && (
          <Badge
            label="Effort"
            value={`${report.estimated_effort_to_review}/5`}
          />
        )}
        <Badge
          label="Tests"
          value={isYes(report.relevant_tests) ? "yes" : "no"}
          tone={isYes(report.relevant_tests) ? "good" : "warn"}
        />
        <Badge label="Files" value={String(report.files.length)} />
      </div>

      {/* Architecture diagram */}
      {report.architecture_mermaid.trim() && (
        <Section icon={<Network size={11} />} title="Architecture" defaultOpen>
          <MermaidBlock code={report.architecture_mermaid} />
        </Section>
      )}

      {/* Overview */}
      {report.summary && (
        <div className="rounded-lg border border-border-subtle bg-[var(--bg-elevated)]/50 p-2.5">
          <Markdown className="text-[11px]">{report.summary}</Markdown>
        </div>
      )}

      {/* Security — green dot = clear, red dot = concern */}
      <div className="rounded-lg border border-border-subtle bg-[var(--bg-elevated)]/40 p-2.5 flex items-start gap-2">
        <span
          className={cn(
            "size-2 rounded-full shrink-0 mt-0.5",
            hasSecurity ? "bg-[var(--status-error)]" : "bg-emerald-500",
          )}
        />
        <div className="min-w-0">
          <span className="font-medium text-text-secondary">Security</span>
          <div className="mt-0.5 text-text-tertiary">
            {hasSecurity ? report.security_concerns : "No issues found."}
          </div>
        </div>
      </div>

      {/* Files */}
      <div className="eyebrow mt-0.5 px-0.5">Files reviewed</div>
      <div className="flex flex-col gap-1.5">
        {report.files.map((f) => (
          <FileCard
            key={f.path}
            file={f}
            onOpenIssue={onOpenIssue}
            projectPath={projectPath}
            onShare={onShareFile}
          />
        ))}
      </div>

      {report.not_reviewed.length > 0 && (
        <div className="rounded-lg border border-border-subtle bg-[var(--bg-elevated)]/30 p-2.5 text-text-tertiary flex gap-1.5">
          <FileWarning size={12} className="mt-0.5 shrink-0" />
          <div>
            <div className="text-text-secondary">
              {report.not_reviewed.length} file
              {report.not_reviewed.length > 1 ? "s" : ""} not individually
              reviewed
            </div>
            <div className="mt-0.5 font-mono text-[10px] break-all">
              {report.not_reviewed.join(", ")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One file's expandable verdict card with per-file actions. */
export function FileCard({
  file,
  onOpenIssue,
  projectPath,
  onShare,
  defaultOpen = false,
}: {
  file: FileVerdict;
  onOpenIssue: (relativeFile: string, line?: number) => void;
  projectPath?: string;
  onShare?: (file: FileVerdict) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);

  const stash = async () => {
    if (!projectPath) return;
    try {
      await invoke("git_stash_paths", {
        path: projectPath,
        paths: [file.path],
      });
      toast.success(`Stashed ${name}`);
    } catch (e) {
      toast.error(String(e));
    }
  };
  const ignore = async () => {
    if (!projectPath) return;
    try {
      await invoke("fs_add_to_gitignore", { projectPath, pattern: file.path });
      toast.success(`Added ${name} to .gitignore`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="rounded-lg border border-border-subtle bg-[var(--bg-elevated)]/40 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <ChevronRight
          size={12}
          className={cn(
            "text-text-tertiary shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <RiskDot risk={file.risk} />
        <span className="flex-1 min-w-0 truncate">
          <span className="text-text-primary">{name}</span>
          {dir && (
            <span className="text-text-tertiary text-[10px]"> {dir}</span>
          )}
        </span>
        {file.key_issues.length > 0 && (
          <span className="shrink-0 text-[10px] text-amber-400/90 flex items-center gap-0.5">
            <AlertTriangle size={10} /> {file.key_issues.length}
          </span>
        )}
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 pt-0.5 flex flex-col gap-1.5">
          {file.summary && (
            <div className="text-text-secondary leading-relaxed">
              {file.summary}
            </div>
          )}
          {file.key_issues.map((issue, i) => (
            <button
              key={i}
              onClick={() =>
                issue.relevant_file &&
                onOpenIssue(issue.relevant_file, issue.start_line ?? undefined)
              }
              className="text-left rounded-md border border-border-subtle bg-[var(--bg-base)]/60 p-2 hover:bg-bg-hover transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={11} className="text-amber-400 shrink-0" />
                <span className="font-medium text-text-primary">
                  {issue.issue_header}
                </span>
                {typeof issue.start_line === "number" && (
                  <span className="ml-auto font-mono text-[10px] text-text-tertiary">
                    :{issue.start_line}
                  </span>
                )}
              </div>
              <div className="mt-1 text-text-secondary leading-relaxed">
                {issue.issue_content}
              </div>
            </button>
          ))}
          {file.key_issues.length === 0 && (
            <div className="text-text-tertiary">No issues found.</div>
          )}

          {/* Per-file actions */}
          <div className="flex items-center gap-1 pt-1">
            {onShare && file.key_issues.length > 0 && (
              <ActionBtn
                icon={<LinkIcon size={11} />}
                label="Share"
                onClick={() => onShare(file)}
              />
            )}
            {projectPath && (
              <>
                <ActionBtn
                  icon={<Archive size={11} />}
                  label="Stash"
                  onClick={stash}
                />
                <ActionBtn
                  icon={<EyeOff size={11} />}
                  label="Ignore"
                  onClick={ignore}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md border border-border-subtle bg-[var(--bg-base)]/50 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
    >
      {icon}
      {label}
    </button>
  );
}

function Section({
  icon,
  title,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border-subtle bg-[var(--bg-elevated)]/40 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-bg-hover transition-colors cursor-pointer text-text-secondary"
      >
        <ChevronRight
          size={12}
          className={cn(
            "text-text-tertiary shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        {icon}
        <span className="font-medium">{title}</span>
      </button>
      {open && <div className="p-2 pt-0">{children}</div>}
    </div>
  );
}

function RiskDot({ risk }: { risk: string }) {
  const tone =
    risk === "high"
      ? "bg-[var(--status-error)]"
      : risk === "medium"
        ? "bg-[var(--status-warning)]"
        : "bg-text-tertiary";
  return (
    <span
      className={cn("size-1.5 rounded-full shrink-0", tone)}
      title={`risk: ${risk}`}
    />
  );
}

function Badge({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 border text-[10.5px]",
        tone === "good" &&
          "border-[var(--status-success)]/50 bg-[var(--bg-elevated)] text-text-secondary",
        tone === "warn" &&
          "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]",
        tone === "neutral" &&
          "border-border-default bg-[var(--bg-elevated)] text-text-secondary",
      )}
    >
      <span className="text-text-tertiary">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

function isYes(s: string): boolean {
  return s.trim().toLowerCase() === "yes";
}

function scoreTone(score: number): "good" | "warn" | "neutral" {
  if (score >= 80) return "good";
  if (score < 50) return "warn";
  return "neutral";
}
