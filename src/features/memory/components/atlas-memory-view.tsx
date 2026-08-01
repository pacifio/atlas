//! Memory-tab view for the native Atlas (cersei) agent.
//!
//! Surfaces what the Atlas agent produces — its persisted sessions (memories)
//! and the plans it laid out (TodoWrite tool calls) — which otherwise only
//! lived in the chat. Master-detail: a session list on the left, the selected
//! session's plan + transcript on the right. Reads `cersei_list_sessions` +
//! `cersei_session_transcript` (the latter returns UI-neutral replay items).

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Circle, Loader2, ListTodo } from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
import { Markdown } from "@/lib/markdown";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

interface CerseiSessionMeta {
  id: string;
  file_path: string;
  started_at: string | null;
  last_modified: string | null;
  message_count: number;
  preview: string;
}

type ReplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result: string | null;
      is_error: boolean;
    };

interface TodoItem {
  content: string;
  status: string;
}

/** Pull the latest TodoWrite plan out of a transcript, if any. */
function latestPlan(items: ReplayItem[]): TodoItem[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.name === "TodoWrite") {
      const todos = (it.input as { todos?: TodoItem[] } | null)?.todos;
      if (Array.isArray(todos) && todos.length > 0) return todos;
    }
  }
  return null;
}

export function AtlasMemoryView({
  projectPath,
}: {
  projectPath: string | null;
}) {
  const [sessions, setSessions] = useState<CerseiSessionMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<ReplayItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectPath) return;
    invoke<CerseiSessionMeta[]>("cersei_list_sessions", { projectPath })
      .then((s) => {
        setSessions(s);
        setSelected((cur) => cur ?? s[0]?.id ?? null);
      })
      .catch(() => setSessions([]));
  }, [projectPath]);

  const loadTranscript = useCallback(
    (id: string) => {
      if (!projectPath) return;
      setLoading(true);
      setTranscript(null);
      invoke<ReplayItem[]>("cersei_session_transcript", {
        projectPath,
        sessionId: id,
      })
        .then(setTranscript)
        .catch(() => setTranscript([]))
        .finally(() => setLoading(false));
    },
    [projectPath],
  );

  useEffect(() => {
    if (selected) loadTranscript(selected);
  }, [selected, loadTranscript]);

  const plan = useMemo(
    () => (transcript ? latestPlan(transcript) : null),
    [transcript],
  );

  if (!projectPath) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[12px] text-[var(--text-tertiary)]">
          Open a project to view Atlas agent memory.
        </p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
        <AtlasIcon size={20} />
        <p className="text-[12px] text-[var(--text-tertiary)]">
          No Atlas agent sessions yet. Chat with the Atlas agent and its
          sessions + plans appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Sessions */}
      <div className="w-[260px] shrink-0 overflow-y-auto border-r border-[var(--border-default)]">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            className={cn(
              "flex w-full flex-col gap-0.5 border-b border-[var(--border-subtle)] px-3 py-2 text-left transition-colors",
              s.id === selected
                ? "bg-[var(--bg-selected,var(--bg-hover))]"
                : "hover:bg-[var(--bg-hover)]",
            )}
          >
            <span className="truncate text-[12px] text-[var(--text-primary)]">
              {s.preview || "Session"}
            </span>
            <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
              {s.message_count} msg{s.message_count === 1 ? "" : "s"}
              {s.last_modified ? ` · ${timeAgo(s.last_modified)}` : ""}
            </span>
          </button>
        ))}
      </div>

      {/* Detail: plan + transcript */}
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
            <Loader2 size={13} className="animate-spin" /> Loading transcript…
          </div>
        ) : (
          <>
            {plan && (
              <div className="mb-4 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  <ListTodo
                    size={11}
                    className="text-[var(--accent-primary)]"
                  />{" "}
                  Plan
                </div>
                {plan.map((t, i) => (
                  <div key={i} className="flex items-start gap-2 py-0.5">
                    {t.status === "completed" ? (
                      <CheckCircle2
                        size={12}
                        className="mt-0.5 shrink-0 text-[var(--status-success)]"
                      />
                    ) : t.status === "in_progress" ? (
                      <Loader2
                        size={12}
                        className="mt-0.5 shrink-0 animate-spin text-[var(--accent-primary)]"
                      />
                    ) : (
                      <Circle
                        size={12}
                        className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
                      />
                    )}
                    <span
                      className={cn(
                        "text-[12px]",
                        t.status === "completed"
                          ? "text-[var(--text-tertiary)] line-through"
                          : "text-[var(--text-secondary)]",
                      )}
                    >
                      {t.content}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3">
              {(transcript ?? []).map((it, i) => (
                <TranscriptItem key={i} item={it} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TranscriptItem({ item }: { item: ReplayItem }) {
  if (item.kind === "tool") {
    if (item.name === "TodoWrite") return null; // shown as the Plan block above
    return (
      <div className="rounded border border-l-2 border-[var(--border-default)] border-l-[var(--border-strong)] bg-[var(--bg-secondary)] px-3 py-1.5">
        <span className="font-mono text-[11px] text-[var(--text-secondary)]">
          {item.name}
        </span>
        {item.result && (
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-[var(--text-tertiary)]">
            {item.result}
          </pre>
        )}
      </div>
    );
  }
  const roleLabel =
    item.kind === "user"
      ? "User"
      : item.kind === "thinking"
        ? "Thinking"
        : "Atlas";
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        {roleLabel}
      </div>
      <div
        className={cn(
          "text-[12px] leading-relaxed",
          item.kind === "thinking"
            ? "italic text-[var(--text-tertiary)]"
            : "text-[var(--text-secondary)]",
        )}
      >
        <Markdown>{item.text}</Markdown>
      </div>
    </div>
  );
}
