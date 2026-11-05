/**
 * One turn in a Session chat, as a messenger thread. Props-only: the container
 * (`session-chat-message.tsx`) supplies the markdown, the diagram and the jump.
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

import { useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  FileCode2,
  GitCommitHorizontal,
  MessageSquare,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "@tryatlas/design";

import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/agent";

import type { JumpDetail } from "../../lib/session-jump";
import { splitMermaid } from "../../lib/split-mermaid";

/** One thing an answer was grounded in (`SourceRef` in `session-chat-api.ts`). */
export interface SessionChatSource {
  /** `checkpoint`, `tool_call`, `prompt`, `response`, `thinking`, `file`. */
  kind: string;
  label: string;
  entryId: string | null;
  commitSha: string | null;
}

export interface SessionChatMessageViewProps {
  message: ChatMessage;
  streaming: boolean;
  sources?: SessionChatSource[];
  renderMarkdown: (source: string) => ReactNode;
  renderDiagram: (code: string) => ReactNode;
  onJump: (detail: JumpDetail) => void;
}

export function SessionChatMessageView({
  message,
  streaming,
  sources,
  renderMarkdown,
  renderDiagram,
  onJump,
}: SessionChatMessageViewProps) {
  if (message.role === "user") {
    return (
      <div data-slot="session-chat-message" className="flex justify-end px-3 py-1.5">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-card px-3.5 py-2 text-base text-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <Assistant
      message={message}
      streaming={streaming}
      sources={sources}
      renderMarkdown={renderMarkdown}
      renderDiagram={renderDiagram}
      onJump={onJump}
    />
  );
}

function Assistant({
  message,
  streaming,
  sources,
  renderMarkdown,
  renderDiagram,
  onJump,
}: SessionChatMessageViewProps) {
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
    <div data-slot="session-chat-message" className="flex flex-col items-start gap-1.5 px-3 py-1.5">
      {parts.map((part, i) =>
        part.kind === "mermaid" ? (
          // Diagrams break out of the bubble. A rendered graph is not prose and
          // constraining it to 92% of a 420px panel makes it unreadable.
          <div key={i} className="w-full">
            {renderDiagram(part.body)}
          </div>
        ) : (
          <div
            key={i}
            className="max-w-[92%] break-words rounded-2xl rounded-bl-md border border-border-subtle bg-card px-3.5 py-2.5"
          >
            {renderMarkdown(part.body)}
          </div>
        ),
      )}

      {!streaming && sources && sources.length > 0 && <Sources sources={sources} onJump={onJump} />}
    </div>
  );
}

// ── Marker ───────────────────────────────────────────────────────────────────

/** A centred status line — not a turn, so not a bubble. */
function Marker({ children }: { children: ReactNode }) {
  return (
    <div data-slot="session-chat-message" role="status" className="flex justify-center px-3 py-2">
      <span className="text-sm text-muted-foreground">{children}</span>
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
function Sources({
  sources,
  onJump,
}: {
  sources: SessionChatSource[];
  onJump: (detail: JumpDetail) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 text-xs text-disabled transition-colors hover:text-secondary-foreground"
      >
        <Icon
          icon={ChevronDown}
          size="xs"
          className={cn("transition-transform duration-fast", open && "rotate-180")}
        />
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
                onClick={() =>
                  onJump({
                    entryId: source.entryId ?? undefined,
                    commitSha: source.commitSha ?? undefined,
                  })
                }
                disabled={!jumpable}
                className={cn(
                  "flex h-[22px] max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 text-xs transition-colors",
                  jumpable
                    ? "cursor-pointer text-muted-foreground hover:border-border-strong hover:text-foreground"
                    : "cursor-default text-disabled",
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

const SOURCE_ICON: Record<string, LucideIcon> = {
  checkpoint: Check,
  tool_call: Terminal,
  file: FileCode2,
  prompt: MessageSquare,
  response: MessageSquare,
};

function SourceGlyph({ kind }: { kind: string }) {
  return (
    <Icon
      icon={SOURCE_ICON[kind] ?? GitCommitHorizontal}
      size="xs"
      strokeWidth={1.7}
      className={cn("shrink-0", kind === "checkpoint" && "text-success")}
    />
  );
}
