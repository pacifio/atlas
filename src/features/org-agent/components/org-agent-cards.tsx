// The records a tool returned, as one list: the sessions of the week, the
// people found, the messages that matched. Every kind the contract names has
// a row; one this build does not know draws nothing. A row that names a place
// opens it in this app (`org-agent-navigate.ts`); a truncated result says so,
// because "these are all of them" is a claim the reader will act on.

import {
  BookMarked,
  FileText,
  FolderKanban,
  GitCommitHorizontal,
  Hash,
  Link2,
  Lock,
  MessageSquare,
  MessagesSquare,
  PenTool,
  Repeat,
  User,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { DiffStat } from "@/features/artifacts/components/session-row";
import { AgentGlyph } from "@/features/artifacts/components/agent-glyph";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

import { cardKey, cardTarget, type OrgAgentTarget } from "../lib/org-agent-links";
import type { Card } from "../lib/org-agent-types";

/** Rows shown before "Show N more". */
const FOLDED = 4;

export function CardList({
  cards,
  truncated = false,
  onOpen,
}: {
  cards: readonly Card[];
  truncated?: boolean;
  onOpen: (target: OrgAgentTarget) => void;
}) {
  const [all, setAll] = useState(false);
  if (cards.length === 0) return null;
  const seen = new Set<string>();
  const unique = cards.filter((c) => {
    const k = cardKey(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const shown = all ? unique : unique.slice(0, FOLDED);
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-card">
        {shown.map((card) => (
          <li key={cardKey(card)}>
            <CardRow card={card} onOpen={onOpen} />
          </li>
        ))}
      </ul>
      {(unique.length > FOLDED || truncated) && (
        <div className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
          {unique.length > FOLDED && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="cursor-pointer hover:text-foreground"
            >
              {all ? "Show fewer" : `Show ${unique.length - FOLDED} more`}
            </button>
          )}
          {truncated && <span>Atlas saw more than it could list here.</span>}
        </div>
      )}
    </div>
  );
}

interface RowParts {
  icon: LucideIcon | null;
  lead?: React.ReactNode;
  title: string;
  mono?: string;
  detail?: React.ReactNode;
  trailing?: React.ReactNode;
}

function partsOf(card: Card): RowParts | null {
  switch (card.kind) {
    case "session":
      return {
        icon: null,
        lead: <AgentGlyph agent={card.agent} size={12} />,
        title: card.title || "Untitled session",
        mono: card.handle,
        detail: [card.author, timeAgo(new Date(card.started_at).toISOString(), { suffix: true })]
          .filter(Boolean)
          .join(" · "),
        trailing: card.live ? <LiveDot /> : undefined,
      };
    case "checkpoint":
      return {
        icon: GitCommitHorizontal,
        title: card.branch || "Checkpoint",
        mono: card.commit_sha.slice(0, 7),
        detail: `${card.files} ${card.files === 1 ? "file" : "files"}`,
        trailing: <DiffStat added={card.plus} removed={card.minus} />,
      };
    case "person":
      return {
        icon: User,
        title: card.name,
        detail: card.role,
        trailing: card.online ? <LiveDot label="Online" /> : undefined,
      };
    case "project":
      return {
        icon: FolderKanban,
        title: card.name,
        mono: card.handle,
        trailing: card.restricted ? <Lock size={11} aria-label="Restricted" /> : undefined,
      };
    case "conversation":
      return {
        icon: card.conv_kind === "channel" ? Hash : MessagesSquare,
        title: card.name,
        detail: card.conv_kind === "channel" ? "Channel" : "Direct message",
      };
    case "message":
      return {
        icon: MessageSquare,
        title: card.excerpt || "Message",
        detail: [card.author, timeAgo(new Date(card.at).toISOString(), { suffix: true })]
          .filter(Boolean)
          .join(" · "),
      };
    case "comment":
      return {
        icon: MessageSquare,
        title: card.excerpt || "Comment",
        mono: card.handle,
        detail: card.author,
      };
    case "space_page":
      return { icon: PenTool, title: card.name || "Space page", detail: "Space" };
    case "fact":
      return { icon: BookMarked, title: card.text, mono: card.handle };
    case "loop":
      return { icon: Repeat, title: card.name, detail: "Loop" };
    case "link":
      return { icon: Link2, title: card.label };
    default:
      return null;
  }
}

function CardRow({ card, onOpen }: { card: Card; onOpen: (target: OrgAgentTarget) => void }) {
  const parts = partsOf(card);
  if (!parts) return null;
  const target = cardTarget(card);
  const Glyph = parts.icon ?? FileText;
  const body = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {parts.lead ?? <Glyph size={12} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-foreground">{parts.title}</span>
          {parts.mono && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">{parts.mono}</span>
          )}
        </span>
        {parts.detail && (
          <span className="truncate text-2xs text-muted-foreground">{parts.detail}</span>
        )}
      </span>
      {parts.trailing && (
        <span className="flex shrink-0 items-center text-muted-foreground">{parts.trailing}</span>
      )}
    </>
  );
  const row = "flex w-full items-center gap-2 px-2.5 py-1.5 text-left";
  return target ? (
    <button
      type="button"
      onClick={() => onOpen(target)}
      className={cn(row, "cursor-pointer transition-colors duration-fast hover:bg-element-hover")}
    >
      {body}
    </button>
  ) : (
    <div className={row}>{body}</div>
  );
}

function LiveDot({ label = "Live" }: { label?: string }) {
  return <span aria-label={label} title={label} className="size-1.5 rounded-full bg-success" />;
}
