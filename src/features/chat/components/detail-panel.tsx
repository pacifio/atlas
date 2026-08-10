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
// Diffs are NOT here. A turn's changes open `GitDiffModal` — the real
// side-by-side viewer at full-window size. Two code panes plus a gutter do not
// fit in a 460px column, so every attempt to host a diff here ended either with
// clipped lines or with the whole box scrolling sideways.

import { useCallback, useMemo, useRef, useEffect } from "react";
import { ChevronRight, TerminalSquare, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";
import {
  useDetailPanelStore,
  DETAIL_MIN_WIDTH,
  DETAIL_MAX_WIDTH,
  type PanelTarget,
} from "../stores/detail-panel-store";

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
      style={{ width: Math.max(DETAIL_MIN_WIDTH, Math.min(DETAIL_MAX_WIDTH, width)) }}
      className="absolute right-0 top-0 bottom-0 z-30 flex flex-col border-l border-[var(--border-default)] bg-[var(--bg-sidebar)] shadow-[var(--shadow-overlay)] animate-slide-in-right"
    >
      <div
        onMouseDown={onResizeStart}
        className="absolute -left-px top-0 z-10 h-full w-px cursor-col-resize bg-border-default transition-colors hover:bg-accent"
        title="Drag to resize"
      />
      <PanelBody target={target} byId={byId} onClose={onClose} />
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

  return (
    <>
      <Header
        icon={<TerminalSquare size={11} className="text-[var(--text-tertiary)]" />}
        title={tc?.toolName ?? "Output"}
        onClose={onClose}
        action={
          output ? (
            <button
              type="button"
              onClick={() => void copyText(output)}
              title="Copy output"
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            >
              <Copy size={11} />
            </button>
          ) : undefined
        }
      />
      <div className="flex-1 overflow-auto hide-scrollbar">
        {tc && Object.keys(tc.arguments ?? {}).length > 0 && (
          <div className="border-b border-[var(--border-subtle)] px-3 py-2">
            <div className="pb-1 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
              Arguments
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--text-secondary)] select-text">
              {JSON.stringify(tc.arguments, null, 2)}
            </pre>
          </div>
        )}
        {output ? (
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-snug text-[var(--text-secondary)] select-text">
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
    <div className="flex h-[32px] shrink-0 items-center justify-between border-b border-[var(--border-default)] px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-[11px] font-medium text-[var(--text-secondary)]">
          {title}
        </span>
        {count !== undefined && (
          <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">· {count}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {action}
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
        >
          <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-3 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
