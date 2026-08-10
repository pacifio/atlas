import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore } from "../../stores/git-store";

/**
 * Live output strip for a streaming git operation (`atlas:git:op`): appears
 * under the commit box the moment the child (or one of its hooks) prints a
 * line, auto-scrolls while running, and stays up on failure so the hook's
 * actual complaint is readable. GitHub Desktop shows hook output in its
 * commit popover for the same reason — a silent slow pre-commit hook reads
 * as a hung app.
 */
export function GitOpOutput() {
  const activeOp = useGitStore.use.activeOp();
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the newest line while the operation is running.
  useEffect(() => {
    if (!activeOp?.running || collapsed) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeOp?.lines.length, activeOp?.running, collapsed]);

  // New operation → expand again.
  useEffect(() => {
    if (activeOp?.running) setCollapsed(false);
  }, [activeOp?.opId, activeOp?.running]);

  if (!activeOp || activeOp.lines.length === 0) return null;

  const failed = !activeOp.running && activeOp.error !== null;

  return (
    <div className="shrink-0 border-t border-border-default">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1.5 px-2 h-[22px] text-[10px] text-text-tertiary hover:text-text-secondary"
      >
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        {activeOp.running ? (
          <>
            <Loader2 size={10} className="animate-spin" />
            <span>
              Running {activeOp.kind}
              {activeOp.kind === "commit" ? " (hooks may be running)" : ""}…
            </span>
          </>
        ) : failed ? (
          <>
            <XCircle size={10} className="text-[var(--status-error)]" />
            <span className="text-[var(--status-error)]">
              {activeOp.kind} failed — output below
            </span>
          </>
        ) : (
          <span>{activeOp.kind} output</span>
        )}
        <span className="ml-auto font-mono">{activeOp.lines.length} lines</span>
      </button>
      {!collapsed && (
        <div
          ref={scrollRef}
          className="max-h-[120px] overflow-y-auto hide-scrollbar bg-[var(--bg-base)] px-2 py-1"
        >
          {activeOp.lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "font-mono text-[10px] leading-[15px] whitespace-pre-wrap break-all",
                l.stream === "stderr" && failed
                  ? "text-[var(--status-error)]"
                  : "text-text-secondary",
              )}
            >
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
