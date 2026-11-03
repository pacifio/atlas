import { memo, useEffect, useRef, useState } from "react";
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

  // Auto-scroll to the newest line while the operation is running. Keyed on
  // the newest line's `seq`, not the count: once the cap is reached the count
  // stops changing. In a frame callback, so reading `scrollHeight` never
  // forces a layout in the middle of a commit.
  const newestSeq = activeOp?.lines[activeOp.lines.length - 1]?.seq;
  useEffect(() => {
    if (!activeOp?.running || collapsed) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [newestSeq, activeOp?.running, collapsed]);

  // New operation → expand again.
  useEffect(() => {
    if (activeOp?.running) setCollapsed(false);
  }, [activeOp?.opId, activeOp?.running]);

  if (!activeOp || activeOp.lines.length === 0) return null;

  const failed = !activeOp.running && activeOp.error !== null;

  return (
    <div className="shrink-0 border-t border-border-subtle">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1.5 px-2 h-control-sm text-2xs font-medium text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-secondary-foreground"
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
            <XCircle size={10} className="text-error" />
            <span className="text-error">{activeOp.kind} failed — output below</span>
          </>
        ) : (
          <span>{activeOp.kind} output</span>
        )}
        <span className="ml-auto font-mono tabular-nums">{activeOp.lines.length} lines</span>
      </button>
      {!collapsed && (
        <div
          ref={scrollRef}
          className="max-h-[120px] overflow-y-auto hide-scrollbar bg-background px-2 py-1.5 select-text cursor-text"
        >
          {/* Keyed by `seq`: when the cap trims the front, existing rows
              keep their keys and only the new ones mount. */}
          {activeOp.lines.map((l) => (
            <OpLineRow key={l.seq} text={l.text} error={l.stream === "stderr" && failed} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One output line. Memoised, so a new batch re-renders only its own rows. */
const OpLineRow = memo(function OpLineRow({ text, error }: { text: string; error: boolean }) {
  return (
    <div
      className={cn(
        "font-mono text-2xs whitespace-pre-wrap break-all",
        error ? "text-error" : "text-secondary-foreground",
      )}
    >
      {text}
    </div>
  );
});
