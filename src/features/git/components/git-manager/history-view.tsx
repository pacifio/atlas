import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Copy, Undo2, GitGraph, RotateCcw, Sparkles, Tag, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { DiffView } from "../diff-view";

export function HistoryView() {
  const repoPath = useGitStore.use.repoPath();
  const log = useGitStore.use.log();
  const selected = useGitStore.use.selectedCommit();
  const actions = useGitStore.use.actions();
  const [copied, setCopied] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [tagName, setTagName] = useState("");

  useEffect(() => {
    if (repoPath) void actions.loadLog(repoPath);
  }, [repoPath, actions]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      handleGitError(e);
    }
  };

  // ── Commit detail ──────────────────────────────────────────────
  if (selected) {
    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 border-b border-border-default">
          <div className="flex items-center gap-2 px-2 h-[30px]">
            <button
              onClick={() => actions.clearSelectedCommit()}
              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
              title="Back to history"
            >
              <ArrowLeft size={13} />
            </button>
            <span className="font-mono text-[11px] text-text-secondary">{selected.shortHash}</span>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(selected.hash).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Copy SHA"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
              <button
                onClick={() => run(() => actions.cherryPick(selected.hash))}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Cherry-pick onto current branch"
              >
                <GitGraph size={12} />
              </button>
              <button
                onClick={() => run(() => actions.revert(selected.hash))}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Revert this commit"
              >
                <Undo2 size={12} />
              </button>
              <ResetMenu onReset={(mode) => run(() => actions.reset(selected.hash, mode))} />
              <button
                onClick={() => setTagging((v) => !v)}
                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                title="Tag this commit"
              >
                <Tag size={12} />
              </button>
            </div>
          </div>
          {tagging && (
            <div className="px-2 pb-2">
              <input
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                autoFocus
                placeholder="tag name → Enter"
                className="w-full h-7 rounded border border-border-default bg-bg-input px-2 text-[11px] font-mono text-text-primary outline-none focus:border-border-focus"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagName.trim()) {
                    void run(() => actions.createTag(tagName.trim(), selected.hash));
                    setTagging(false);
                    setTagName("");
                  } else if (e.key === "Escape") {
                    setTagging(false);
                    setTagName("");
                  }
                }}
              />
            </div>
          )}
          <div className="px-3 pb-2">
            <div className="text-[12px] text-text-primary font-medium">{selected.subject}</div>
            {selected.body && (
              <pre className="mt-1 max-h-32 overflow-y-auto hide-scrollbar whitespace-pre-wrap break-words font-sans text-[11px] text-text-tertiary">
                {selected.body}
              </pre>
            )}
            <div className="mt-1 text-[10px] text-text-tertiary">
              {selected.author} · {selected.date}
            </div>
            <CommitSessions sha={selected.hash} />
          </div>
        </div>
        <DiffView diff={selected.diff} className="flex-1 min-h-0" emptyLabel="No file changes" />
      </div>
    );
  }

  // ── Commit list ────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto hide-scrollbar">
      {log.length === 0 ? (
        <div className="px-3 py-8 text-center text-[11px] text-text-tertiary">No history</div>
      ) : (
        log.map((c, i) => (
          <div key={c.hash} className="relative group">
            <button
              onClick={() => void actions.loadCommit(c.hash)}
              className="w-full text-left flex flex-col gap-0.5 px-3 py-1.5 border-b border-border-subtle hover:bg-bg-hover"
            >
              <span className="text-[11px] text-text-secondary group-hover:text-text-primary truncate pr-12">
                {c.message}
              </span>
              <span className="text-[9px] text-text-tertiary font-mono">
                {c.short_hash} · {c.author} · {c.date}
              </span>
            </button>
            {i === 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void run(() => actions.undoCommit());
                }}
                className="absolute right-2 top-1.5 opacity-0 group-hover:opacity-100 px-1.5 h-[16px] rounded border border-border-default text-[9px] text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                title="Undo this commit — changes return to the staged area (blocked once pushed)"
              >
                Undo
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function ResetMenu({ onReset }: { onReset: (mode: "soft" | "mixed" | "hard") => void }) {
  const [open, setOpen] = useState(false);
  const item = (mode: "soft" | "mixed" | "hard", label: string, desc: string) => (
    <button
      onClick={() => {
        onReset(mode);
        setOpen(false);
      }}
      className="w-full text-left px-3 py-1.5 hover:bg-bg-hover"
    >
      <div className="text-[11px] text-text-primary">{label}</div>
      <div className="text-[9px] text-text-tertiary">{desc}</div>
    </button>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className={cn(
            "p-1 rounded hover:bg-bg-hover",
            open ? "text-text-primary" : "text-text-tertiary hover:text-text-primary",
          )}
          title="Reset current branch to this commit"
        >
          <RotateCcw size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="w-[200px] rounded-lg border border-border-default bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] py-1"
          style={{ zIndex: 99999 }}
        >
          <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-text-tertiary">
            Reset to here
          </div>
          {item("soft", "Soft", "keep changes staged")}
          {item("mixed", "Mixed", "keep changes unstaged")}
          {item("hard", "Hard", "discard all changes")}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One Session that produced this commit. */
interface CommitSession {
  sessionId: string;
  title: string | null;
  messageCount: number;
  toolCallCount: number;
  files: string[];
}

/**
 * The Sessions behind the selected commit — the answer to "why is this written
 * this way", offered where the question actually gets asked.
 *
 * Renders nothing at all when the commit has no recorded Session, which is the
 * common case: capture may be off, the commit may predate it, or it may be
 * human work the link rule deliberately did not attribute to an agent.
 */
function CommitSessions({ sha }: { sha: string }) {
  const repoPath = useGitStore.use.repoPath();
  const addTab = useLayoutStore.use.actions().addTab;
  const [sessions, setSessions] = useState<CommitSession[]>([]);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setSessions([]);
    invoke<CommitSession[]>("capture_commit_sessions", { projectPath: repoPath, commitSha: sha })
      .then((found) => {
        if (!cancelled) setSessions(found);
      })
      // A Workspace with capture off returns an empty list rather than failing,
      // so reaching here means a store-level problem. The git panel is not the
      // place to report it — capture health already owns that signal.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, sha]);

  if (sessions.length === 0) return null;

  const open = (sessionId: string) => {
    if (!repoPath) return;
    // The sha travels with the request so the Session lands on this commit's
    // Checkpoint rather than at the top of a conversation that may have
    // produced several.
    useArtifactsStore
      .getState()
      .actions.openSession({ sessionId, projectPath: repoPath, commitSha: sha });
    addTab({
      id: "artifacts",
      type: "artifacts",
      title: "Timeline",
      closable: true,
      dirty: false,
      data: {},
    });
  };

  return (
    <div className="mt-2 border-t border-border-subtle pt-2">
      <div className="text-[9px] uppercase tracking-wider text-text-tertiary">
        Produced by {sessions.length} session{sessions.length === 1 ? "" : "s"}
      </div>
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          onClick={() => open(s.sessionId)}
          className="mt-1 w-full rounded border border-border-default bg-bg-raised px-2 py-1.5 text-left hover:bg-bg-hover group"
          title="Open this Session in the Timeline"
        >
          <div className="flex items-start gap-1.5">
            <Sparkles size={11} className="mt-0.5 shrink-0 text-text-tertiary" />
            <span className="text-[11px] text-text-secondary group-hover:text-text-primary line-clamp-2">
              {s.title ?? "Untitled session"}
            </span>
          </div>
          <div className="mt-0.5 pl-[18px] text-[9px] text-text-tertiary truncate">
            {s.messageCount} message{s.messageCount === 1 ? "" : "s"} · {s.toolCallCount} tool call
            {s.toolCallCount === 1 ? "" : "s"}
            {s.files.length > 0 && ` · ${s.files.join(", ")}`}
          </div>
        </button>
      ))}
    </div>
  );
}
