import type { ReactNode, Ref } from "react";
import { FilePlus2, Loader2, Plus } from "lucide-react";
import { Hint, Skeleton, Tooltip, TooltipContent, TooltipTrigger } from "@tryatlas/design";
import { timeAgo } from "@/lib/time-ago";
import type { PromptDraft } from "../../types";

export interface DraftAuthor {
  /** The full name; null when the member is not in the roster. */
  name: string | null;
  avatar: ReactNode;
}

export interface DraftsTabViewProps {
  /** `undefined` is never fetched (skeleton); `[]` is a real answer. */
  drafts: PromptDraft[] | undefined;
  title: string;
  onTitleChange: (title: string) => void;
  creating: boolean;
  onCreate: () => void;
  onOpen: (draft: PromptDraft) => void;
  titleMax: number;
  inputRef: Ref<HTMLInputElement>;
  author: (userId: string) => DraftAuthor;
}

/**
 * A conversation's prompt drafts, drawn from props: the create row, then one
 * row per draft in the server's order. The container (`drafts-tab.tsx`) owns
 * the list, the poll and the create call.
 */
export function DraftsTabView({
  drafts,
  title,
  onTitleChange,
  creating,
  onCreate,
  onOpen,
  titleMax,
  inputRef,
  author,
}: DraftsTabViewProps) {
  return (
    <div data-view="drafts-tab" className="flex min-h-0 flex-1 flex-col">
      {/* One full-width band with the action inline, matching the
          sidebar's search row (`sidebar-session-header.tsx`) — a boxed input
          floating inside padding read as a second, competing surface. */}
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border px-3">
        <FilePlus2 size={11} className="shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={title}
          maxLength={titleMax}
          onChange={(e) => onTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCreate();
            }
          }}
          placeholder="Name a new draft…"
          aria-label="New draft title"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        <Hint label="Create draft">
          <button
            type="button"
            aria-label="Create draft"
            disabled={!title.trim() || creating}
            onClick={onCreate}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={12} />}
          </button>
        </Hint>
      </div>

      <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto pb-3">
        {drafts === undefined &&
          [0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5 px-3 py-[9px]">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-[9px]" style={{ width: 110 + ((i * 37) % 60) }} />
            </div>
          ))}
        {drafts?.length === 0 && (
          <p className="px-3 pt-4 text-center text-xs text-disabled">No drafts yet.</p>
        )}
        {drafts?.map((d) => (
          <DraftRow key={d.id} draft={d} author={author(d.created_by)} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function DraftRow({
  draft: d,
  author,
  onOpen,
}: {
  draft: PromptDraft;
  author: DraftAuthor;
  onOpen: (draft: PromptDraft) => void;
}) {
  // Table row, not a card: title takes the width it can, then a fixed author
  // column, then the created date — so the eye scans a straight edge down the
  // list instead of a ragged one.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(d)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(d);
      }}
      className="flex cursor-pointer items-center gap-2 border-b border-border-subtle px-3 py-2 transition-colors last:border-b-0 hover:bg-element-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{d.title}</span>
          {d.sent_at !== null && (
            <span className="shrink-0 rounded-full bg-element-active px-1.5 py-px text-2xs font-medium text-foreground">
              sent
            </span>
          )}
        </div>
        <span className="mt-0.5 block truncate text-2xs text-disabled">
          Updated {timeAgo(new Date(d.updated_at).toISOString(), { suffix: true })}
        </span>
      </div>

      {/* The tooltip carries the FULL name — the label beside the avatar is
          only the first. A draft list is short and deliberate (not a
          mass-rendered transcript row), so it earns the real component over a
          native title. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="flex min-w-0 shrink-0 items-center">
              {author.avatar}
              <span className="ml-1 max-w-[72px] truncate text-2xs text-muted-foreground">
                {firstName(author.name)}
              </span>
            </span>
          }
        />
        <TooltipContent side="top" sideOffset={4}>
          Created by {author.name ?? "Unknown"}
        </TooltipContent>
      </Tooltip>

      <span className="w-[62px] shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
        {formatCreated(d.created_at)}
      </span>
    </div>
  );
}

/** Created dates are calendar facts, not elapsed ones — a short absolute date
 *  reads faster in a column than "3 weeks ago", and the relative form is
 *  already carrying the updated-at line above it. */
function formatCreated(at: number): string {
  const d = new Date(at);
  const now = new Date();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "2-digit" }),
  });
}

/** Just the given name — the row has a date column to protect, and the
 *  tooltip still carries the whole name for anyone who asks. */
function firstName(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "Unknown";
}
