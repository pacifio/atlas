// Right-hand detail panel: tool arguments and tool output.
//
// This is the other half of the perf story. Inline expanding diff blocks were
// the single largest source of unpredictable row height in the old transcript —
// a row that grows when clicked is exactly what the virtualizer cannot predict.
// Moving them here is both the UX win (a quiet, scannable thread) and the thing
// that makes deterministic heights possible. One change, two reasons.
//
// Contract with the transcript: opening, closing or retargeting this panel must
// not re-render a single transcript row. Panel state lives in its own store and
// rows only ever write to it imperatively.
//
// Diffs are NOT here. A turn's changes open in the review panel beside the
// session, in the turn's own scope (`openTurnDiff`). Two code panes plus a gutter do not
// fit in a 460px column, so every attempt to host a diff here ended either with
// clipped lines or with the whole box scrolling sideways.

import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, TerminalSquare } from "lucide-react";
import { CopyGlyph } from "@/ui/animated-icon";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useSubagent } from "../hooks/use-subagents";
import { elapsedMs } from "../lib/subagents";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { settledFigure, SUBAGENT_STATE } from "./transcript-rows";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { usePaneTopInset } from "@/features/layout/lib/pane-top-inset";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";
import {
  useDetailPanelStore,
  DETAIL_MIN_WIDTH,
  DETAIL_MAX_WIDTH,
  type PanelTarget,
} from "../stores/detail-panel-store";

/** "Copied" for a moment after a copy lands, then back. `count` goes up once
 *  per copy: it is the `HintItem` `reshowKey`, so a repeat copy re-confirms. */
function useCopiedFlash() {
  const [copied, setCopied] = useState(false);
  const [count, setCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setCopied(true);
    setCount((n) => n + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, []);
  return { copied, count, flash };
}

// ── Panel ──────────────────────────────────────────────────────────────────

/** Every tool call in the thread, flat — the panel addresses them by id. */
function useToolCalls(messages: ChatMessage[]) {
  return useMemo(() => {
    const byId = new Map<string, ToolCallDisplay>();
    for (const m of messages) {
      for (const tc of m.toolCalls) byId.set(tc.id, tc);
    }
    return byId;
  }, [messages]);
}

export function DetailPanel({ tabId, messages }: { tabId: string; messages: ChatMessage[] }) {
  const target = useDetailPanelStore((s) => s.targets[tabId] ?? null);
  const width = useDetailPanelStore((s) => s.width);
  const { close, setWidth } = useDetailPanelStore.use.actions();
  const byId = useToolCalls(messages);
  // The session column's window bar floats over this pane (z-titlebar); start
  // below it, or the bar covers this panel's header and eats its clicks.
  const topInset = usePaneTopInset();

  const onClose = useCallback(() => close(tabId), [close, tabId]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  // Left-edge resize (the panel is anchored right, so dragging left widens).
  const startX = useRef<number | null>(null);
  const startW = useRef(0);
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      startW.current = width;
      const onMove = (ev: MouseEvent) => {
        if (startX.current === null) return;
        setWidth(startW.current + (startX.current - ev.clientX));
      };
      const onUp = () => {
        startX.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, setWidth],
  );

  if (!target) return null;

  return (
    <div
      style={{
        width: Math.max(DETAIL_MIN_WIDTH, Math.min(DETAIL_MAX_WIDTH, width)),
        top: topInset,
      }}
      className="absolute right-0 bottom-0 z-30 flex flex-col border-l border-[var(--border)] bg-[var(--sidebar)] shadow-md animate-slide-in-right"
    >
      <div
        onMouseDown={onResizeStart}
        className="absolute -left-px top-0 z-10 h-full w-px cursor-col-resize bg-border transition-colors hover:bg-primary"
        title="Drag to resize"
      />
      {target.kind === "subagent" ? (
        <SubagentBody tabId={tabId} toolCallId={target.toolCallId} byId={byId} onClose={onClose} />
      ) : (
        <PanelBody target={target} byId={byId} onClose={onClose} />
      )}
    </div>
  );
}

function PanelBody({
  target,
  byId,
  onClose,
}: {
  target: NonNullable<PanelTarget>;
  byId: Map<string, ToolCallDisplay>;
  onClose: () => void;
}) {
  const tc = byId.get(target.toolCallId);
  const output = tc?.result ?? "";
  const copy = useCopiedFlash();

  return (
    <>
      <Header
        icon={<TerminalSquare size={11} className="text-[var(--muted-foreground)]" />}
        title={tc?.toolName ?? "Output"}
        onClose={onClose}
        action={
          output ? (
            <HintItem label={copy.copied ? "Copied" : "Copy output"} reshowKey={copy.count}>
              <button
                type="button"
                onClick={() => void copyText(output).then((ok) => ok && copy.flash())}
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
              >
                <CopyGlyph copied={copy.copied} size="sm" />
              </button>
            </HintItem>
          ) : undefined
        }
      />
      <div className="flex-1 overflow-auto hide-scrollbar">
        {tc && Object.keys(tc.arguments ?? {}).length > 0 && (
          <div className="border-b border-[var(--atlas-border-subtle)] px-3 py-2">
            <div className="pb-1 text-3xs uppercase tracking-wider text-[var(--muted-foreground)]">
              Arguments
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-snug text-[var(--secondary-foreground)] select-text">
              {JSON.stringify(tc.arguments, null, 2)}
            </pre>
          </div>
        )}
        {output ? (
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-snug text-[var(--secondary-foreground)] select-text">
            {output}
          </pre>
        ) : (
          <Empty>
            {tc?.status === "running" || tc?.status === "pending" ? "Still running…" : "No output."}
          </Empty>
        )}
      </div>
    </>
  );
}

/**
 * A delegated child's own body: what it was asked, what it did, what it said.
 *
 * Opens the child beside the thread rather than unfolding it inside one. Two shapes of child land here
 * and the panel must not lie about either:
 *
 *   * a STREAMING child (Claude's) has its calls attributed to this session,
 *     so "what it did" is a real list that grows while you watch;
 *   * a MAIL child (the native engine's) runs on a thread this session never
 *     sees. Its calls are not missing, they are elsewhere — so the panel says
 *     so rather than showing an empty list, which would read as "did nothing".
 */
/**
 * A delegated child's own thread — the agent chat, scoped to one child.
 *
 * A bar naming the child, then its conversation. That shape is the point. A child IS a thread — it was given a
 * task and it answered — so reading it as a transcript, in the transcript's
 * own idiom (the task as the prompt, the answer as prose, its calls as
 * markers between them), means a reader already knows how to read it. The
 * first version of this panel rendered the answer into a `<pre>`, which turned
 * every list, heading and code fence the child wrote into one grey blob.
 *
 * Two shapes of child land here and the panel must not lie about either:
 *
 *   * a STREAMING child (Claude's) has its calls attributed to this session,
 *     so its work is a real list that grows while you watch;
 *   * a MAIL child (the native engine's) runs on a thread this session never
 *     sees. Its calls are not missing, they are elsewhere — so the panel says
 *     so rather than showing an empty list, which would read as "did nothing".
 */
function SubagentBody({
  tabId,
  toolCallId,
  byId,
  onClose,
}: {
  tabId: string;
  toolCallId: string;
  byId: Map<string, ToolCallDisplay>;
  onClose: () => void;
}) {
  const child = useSubagent(tabId, toolCallId);
  const copy = useCopiedFlash();
  // Its own calls, in transcript order. Read from the map the panel already
  // built rather than re-scanning the thread.
  const calls = useMemo(
    () => [...byId.values()].filter((call) => call.parentToolCallId === toolCallId),
    [byId, toolCallId],
  );
  if (!child) return null;

  const running = child.status === "running";
  const name = child.name.trim() || "Subagent";
  return (
    <>
      {/* The chat's own bar: back out of the child, the child's name, and what
          it is on the right — the slot the agent chat puts the model in. */}
      <div className="flex h-[32px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-2">
        <button
          type="button"
          aria-label="Back"
          onClick={onClose}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
        >
          <ArrowLeft size={13} />
        </button>
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            child.status === "failed"
              ? "bg-[var(--atlas-status-error-foreground)]"
              : running
                ? "bg-[var(--primary)] atlas-marker-running"
                : "bg-[var(--atlas-text-disabled)]",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--foreground)]">
          {name}
        </span>
        <span className="shrink-0 font-mono text-2xs text-[var(--muted-foreground)]">
          {child.role ? `${child.role} · ` : ""}
          {SUBAGENT_STATE[child.status]}
        </span>
      </div>

      <div className="hide-scrollbar flex-1 overflow-auto px-4 py-3">
        {/* The task, as the prompt that started this thread. Right-aligned in
            the same bubble a user message wears, because that is what it is
            from the child's side. */}
        {child.prompt && (
          <div className="mb-4 flex justify-end">
            <p className="max-w-full min-w-0 select-text rounded-xl bg-[var(--atlas-primary-muted)] px-3.5 py-2 text-sm whitespace-pre-wrap text-[var(--foreground)]">
              {child.prompt}
            </p>
          </div>
        )}

        {/* A child on a thread of its own (the engine's) did its work where
            this session cannot see it. Said in the work's place, so an
            answer with nothing above it does not read as a child that did
            nothing — and never as a count of 0. */}
        {calls.length === 0 && child.ownThread && child.result && (
          <p className="mb-3 text-xs text-[var(--muted-foreground)]">
            Ran on its own thread — its steps are not shown here.
          </p>
        )}

        {/* Its work, as markers — the same line a tool call gets in the
            transcript, so a child's run reads like any other. */}
        {calls.length > 0 && (
          <div className="mb-3">
            {calls.map((call) => (
              <p
                key={call.id}
                className="atlas-marker text-xs text-[var(--muted-foreground)]"
                title={call.toolName}
              >
                <span
                  aria-hidden
                  className="size-1 shrink-0 rounded-full bg-[var(--atlas-text-disabled)]"
                />
                <span className="min-w-0 truncate">{call.toolName}</span>
              </p>
            ))}
          </div>
        )}

        {/* The answer, rendered as prose. `atlas-prose` is the transcript's own
            block styling, so a child's lists and code fences look exactly like
            the parent's. */}
        {child.result ? (
          <div className="select-text">
            <CachedMarkdown source={child.result} unstyled priority={0} className="atlas-prose" />
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            {running
              ? "Still working…"
              : calls.length === 0 && child.toolCallCount === 0
                ? "This agent ran on its own thread and reported nothing back."
                : "No result."}
          </p>
        )}

        {/* The footer the agent chat puts under a reply: what you can do with
            it, and how long it took. */}
        {child.result && (
          <div className="mt-3 flex items-center gap-2">
            <HintItem label={copy.copied ? "Copied" : "Copy result"} reshowKey={copy.count}>
              <button
                type="button"
                onClick={() => void copyText(child.result ?? "").then((ok) => ok && copy.flash())}
                className="flex size-5 cursor-pointer items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
              >
                <CopyGlyph copied={copy.copied} size="sm" />
              </button>
            </HintItem>
            <span className="font-mono text-2xs text-[var(--atlas-text-disabled)] tabular-nums">
              {settledFigure(elapsedMs(child, Date.now()))}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

function Header({
  icon,
  title,
  count,
  onClose,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  onClose: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-[32px] shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-xs font-medium text-[var(--secondary-foreground)]">
          {title}
        </span>
        {count !== undefined && (
          <span className="shrink-0 text-2xs text-[var(--muted-foreground)]">· {count}</span>
        )}
      </div>
      <HintGroup>
        <div className="flex shrink-0 items-center gap-0.5">
          {action}
          <HintItem label="Close (Esc)">
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
            >
              <ChevronRight size={12} />
            </button>
          </HintItem>
        </div>
      </HintGroup>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-3 text-xs leading-relaxed text-[var(--muted-foreground)]">
      {children}
    </div>
  );
}
