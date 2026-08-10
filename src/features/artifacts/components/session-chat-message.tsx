/**
 * One turn in a Session chat, as a messenger thread.
 *
 * Deliberately **not** the agent chat's `MessageItem`. That component renders a
 * full-width transcript with tool-call cards and turn headers, which is right
 * for watching an agent work and wrong for a conversation: reused here it gave
 * both sides the same left-aligned full-bleed block, so there was no way to tell
 * a question from an answer.
 *
 * The vocabulary is shadcn's Message / Bubble / Marker, mapped to Atlas tokens:
 *
 * * **Bubble** — the turn. The user's is solid and end-aligned; the assistant's
 *   is outlined and start-aligned. Two different treatments rather than two
 *   different alignments alone, because a 90%-wide answer and a 90%-wide
 *   question look identical when only their margin differs.
 * * **Marker** — a centred status line for things that are not turns:
 *   "Thinking…", and the collapsed grounding.
 *
 * An assistant bubble stretches wider than a messenger's would (92% against the
 * user's 85%) because the content is genuinely structured — headings, lists,
 * diffs — and squeezing that into a chat width reflows it into noise.
 */

import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  FileCode2,
  GitCommitHorizontal,
  MessageSquare,
  Terminal,
} from "lucide-react";

import { MermaidBlock } from "@/features/review-agents/components/mermaid-block";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/agent";

import type { SourceRef } from "../lib/session-chat-api";

/**
 * The event a source chip fires. The detail listens and jumps its timeline —
 * an event rather than a prop so the chat needs no handle on the detail's
 * internals, and a citation rendered anywhere works the same way.
 */
export const JUMP_EVENT = "atlas:session-chat-jump";

export interface JumpDetail {
  entryId?: string;
  commitSha?: string;
}

function jumpToSource(source: SourceRef): void {
  window.dispatchEvent(
    new CustomEvent<JumpDetail>(JUMP_EVENT, {
      detail: {
        entryId: source.entryId ?? undefined,
        commitSha: source.commitSha ?? undefined,
      },
    }),
  );
}

/** A chunk of an answer: prose, or a diagram. */
type Part = { kind: "text"; body: string } | { kind: "mermaid"; body: string };

/**
 * Split an answer on mermaid fences.
 *
 * Written to survive a *streaming* answer, where the closing fence has not
 * arrived yet: an unterminated block stays text, so the reader sees the raw
 * source appear and then resolve into a diagram rather than watching mermaid
 * fail to parse a half-written graph on every token.
 */
function splitMermaid(content: string): Part[] {
  const fence = /```mermaid\s*\n([\s\S]*?)```/g;
  const parts: Part[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push({ kind: "text", body: content.slice(cursor, match.index) });
    }
    parts.push({ kind: "mermaid", body: match[1].trim() });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    parts.push({ kind: "text", body: content.slice(cursor) });
  }
  return parts.filter((p) => p.body.trim().length > 0);
}

export function SessionChatMessage({
  message,
  streaming,
  sources,
}: {
  message: ChatMessage;
  streaming: boolean;
  sources: SourceRef[] | undefined;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--bg-elevated-2)] px-3.5 py-2 text-[13px] leading-[1.55] text-[var(--text-primary)]">
          {message.content}
        </div>
      </div>
    );
  }

  return <Assistant message={message} streaming={streaming} sources={sources} />;
}

function Assistant({
  message,
  streaming,
  sources,
}: {
  message: ChatMessage;
  streaming: boolean;
  sources: SourceRef[] | undefined;
}) {
  const parts = useMemo(() => splitMermaid(message.content), [message.content]);

  // Nothing has arrived yet. A marker rather than an empty bubble: an outlined
  // box with nothing in it reads as a failed answer.
  if (parts.length === 0) {
    return (
      <Marker>
        <span className={cn(streaming && "animate-pulse")}>
          {streaming ? "Reading the session…" : "No answer"}
        </span>
      </Marker>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5 px-3 py-1.5">
      {parts.map((part, i) =>
        part.kind === "mermaid" ? (
          // Diagrams break out of the bubble. A rendered graph is not prose and
          // constraining it to 92% of a 420px panel makes it unreadable.
          <div key={i} className="w-full">
            <MermaidBlock code={part.body} controls />
          </div>
        ) : (
          <div
            key={i}
            className="max-w-[92%] break-words rounded-2xl rounded-bl-md border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3.5 py-2.5"
          >
            <CachedMarkdown
              source={part.body}
              className="text-[13px] leading-[1.6] text-[var(--text-secondary)]"
            />
          </div>
        ),
      )}

      {!streaming && sources && sources.length > 0 && <Sources sources={sources} />}
    </div>
  );
}

// ── Marker ───────────────────────────────────────────────────────────────────

/** A centred status line — not a turn, so not a bubble. */
function Marker({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="flex justify-center px-3 py-2">
      <span className="text-[11.5px] text-[var(--text-tertiary)]">{children}</span>
    </div>
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────

/**
 * What the answer read, collapsed.
 *
 * Folded by default, and that is the fix rather than a preference: a grounded
 * answer routinely cites a dozen entries, and rendering those as full-width
 * chips buried the answer under its own footnotes. Closed, it is one line; open,
 * it is the jump targets.
 */
function Sources({ sources }: { sources: SourceRef[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 text-[11px] text-[var(--text-ghost)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} />
        Grounded in {sources.length} {sources.length === 1 ? "source" : "sources"}
      </button>

      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sources.map((source, i) => {
            const jumpable = !!source.entryId || !!source.commitSha;
            return (
              <button
                key={`${source.kind}-${i}`}
                type="button"
                title={source.label}
                onClick={() => jumpToSource(source)}
                disabled={!jumpable}
                className={cn(
                  "flex h-[22px] max-w-full items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-raised)] px-2 text-[10.5px] transition-colors",
                  jumpable
                    ? "cursor-pointer text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                    : "cursor-default text-[var(--text-ghost)]",
                )}
              >
                <SourceGlyph kind={source.kind} />
                <span className="truncate font-mono">{source.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SourceGlyph({ kind }: { kind: string }) {
  const props = { size: 10, strokeWidth: 1.7, className: "shrink-0" } as const;
  switch (kind) {
    case "checkpoint":
      return <Check {...props} className="shrink-0 text-[var(--capture-live)]" />;
    case "tool_call":
      return <Terminal {...props} />;
    case "file":
      return <FileCode2 {...props} />;
    case "prompt":
    case "response":
      return <MessageSquare {...props} />;
    default:
      return <GitCommitHorizontal {...props} />;
  }
}
