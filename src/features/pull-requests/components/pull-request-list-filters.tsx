// The list's filter bar: state and involvement as compact menus, the sort,
// and one Filters menu for author, labels, draft, review and checks. Author
// and label choices come from the loaded rows (`collectPullRequestListFacets`).

import { useState, type ElementType } from "react";
import {
  CalendarArrowDown,
  CalendarArrowUp,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  Eye,
  EyeOff,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Layers,
  ListChecks,
  ListFilter,
  Maximize2,
  Minimize2,
  PenLine,
  Tag,
  UserLock,
  UserRound,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";

import type {
  PullRequestAuthorFacet,
  PullRequestLabelFacet,
  PullRequestListSort,
  PullRequestLocalFilters,
} from "../lib/pull-request-list-logic";
import type { PrInvolvement, PrListState } from "../lib/pull-requests-types";
import { ActorAvatar } from "./pull-request-presentation";

export interface FilterOption<Value extends string> {
  value: Value;
  label: string;
  Icon: ElementType<{ className?: string }>;
}

export const STATE_OPTIONS = [
  { value: "open", label: "Open", Icon: GitPullRequestArrow },
  { value: "closed", label: "Closed", Icon: GitPullRequestClosed },
  { value: "merged", label: "Merged", Icon: GitMerge },
  { value: "all", label: "All states", Icon: Layers },
] as const satisfies readonly FilterOption<PrListState>[];

export const INVOLVEMENT_OPTIONS = [
  { value: "all", label: "Everyone's", Icon: Layers },
  { value: "reviewing", label: "Reviewing", Icon: Eye },
  { value: "authored", label: "Authored", Icon: PenLine },
] as const satisfies readonly FilterOption<PrInvolvement>[];

export const SORT_OPTIONS = [
  { value: "ready", label: "Merge readiness", Icon: ListChecks },
  { value: "blocked", label: "Blocked on me", Icon: UserLock },
  { value: "updated", label: "Recently updated", Icon: Clock },
  { value: "newest", label: "Newest", Icon: CalendarArrowDown },
  { value: "oldest", label: "Oldest", Icon: CalendarArrowUp },
  { value: "largest", label: "Largest", Icon: Maximize2 },
  { value: "smallest", label: "Smallest", Icon: Minimize2 },
] as const satisfies readonly FilterOption<PullRequestListSort>[];

const UNFILTERED = "all";

const DRAFT_OPTIONS = [
  { value: UNFILTERED, label: "All", Icon: Layers },
  { value: "only", label: "Drafts only", Icon: GitPullRequestDraft },
  { value: "hide", label: "Hide drafts", Icon: EyeOff },
] as const satisfies readonly FilterOption<string>[];

const REVIEW_OPTIONS = [
  { value: UNFILTERED, label: "All", Icon: Layers },
  { value: "approved", label: "Approved", Icon: CircleCheck },
  { value: "changes-requested", label: "Changes requested", Icon: CircleX },
  { value: "review-required", label: "Review required", Icon: CircleDashed },
  { value: "none", label: "No reviews", Icon: CircleSlash },
] as const satisfies readonly FilterOption<string>[];

const CHECKS_OPTIONS = [
  { value: UNFILTERED, label: "All", Icon: Layers },
  { value: "passing", label: "Passing", Icon: CircleCheck },
  { value: "failing", label: "Failing", Icon: CircleX },
] as const satisfies readonly FilterOption<string>[];

/** A one-choice menu shown as its current value: the state, the involvement,
 *  the sort. `iconOnly` shows just the current option's glyph. */
export function CompactFilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
  iconOnly = false,
}: {
  label: string;
  value: Value;
  options: readonly FilterOption<Value>[];
  onChange: (value: Value) => void;
  iconOnly?: boolean;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${label}: ${current.label}`}
            title={`${label}: ${current.label}`}
          >
            <current.Icon aria-hidden className="size-3.5 shrink-0" />
            {iconOnly ? null : (
              <>
                <span className="truncate">{current.label}</span>
                <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              </>
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next !== value) onChange(next as Value);
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
              <option.Icon aria-hidden className="size-3.5" />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RadioSubmenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly FilterOption<string>[];
  onChange: (value: string) => void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <current.Icon aria-hidden className="size-3.5" />
        <span className="flex-1">{label}</span>
        <span className="max-w-32 min-w-0 truncate text-muted-foreground">{current.label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next !== value) onChange(String(next));
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.Icon aria-hidden className="size-3.5" />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function AuthorSubmenu({
  value,
  options,
  onChange,
}: {
  value: string | undefined;
  options: readonly PullRequestAuthorFacet[];
  onChange: (author: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const login = value?.toLowerCase() ?? "";
  const selected = options.find((option) => option.actor.login.toLowerCase() === login);
  const visible = [
    ...(selected ? [selected] : []),
    ...options.filter(
      (option) =>
        option !== selected &&
        (!needle ||
          option.actor.login.toLowerCase().includes(needle) ||
          option.actor.name?.toLowerCase().includes(needle)),
    ),
  ].slice(0, 10);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <UserRound aria-hidden className="size-3.5" />
        <span className="flex-1">Author</span>
        <span className="max-w-32 min-w-0 truncate text-muted-foreground">{value ?? "Anyone"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <div className="p-1 pb-1.5">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
            }}
            placeholder="Search authors"
            aria-label="Search authors"
          />
        </div>
        <DropdownMenuRadioGroup
          value={selected?.actor.login ?? value ?? ""}
          onValueChange={(next) => {
            const author = String(next);
            if (author.toLowerCase() !== login) onChange(author || undefined);
          }}
        >
          <DropdownMenuRadioItem value="">
            <Layers aria-hidden className="size-3.5" />
            Anyone
          </DropdownMenuRadioItem>
          {visible.map((option) => (
            <DropdownMenuRadioItem
              key={option.actor.login.toLowerCase()}
              value={option.actor.login}
            >
              <ActorAvatar actor={option.actor} />
              <span className="min-w-0 flex-1 truncate">{option.actor.login}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{option.count}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {visible.length === 0 ? (
          <DropdownMenuItem disabled>No authors among these pull requests</DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function LabelSubmenu({
  value,
  options,
  onChange,
}: {
  value: readonly string[];
  options: readonly PullRequestLabelFacet[];
  onChange: (labels: string[]) => void;
}) {
  const selected = new Set(value.map((name) => name.toLowerCase()));
  const visible = [
    ...value
      .filter((name) => !options.some((option) => option.name.toLowerCase() === name.toLowerCase()))
      .map((name) => ({ name, color: null, count: 0 })),
    ...options,
  ];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Tag aria-hidden className="size-3.5" />
        <span className="flex-1">Labels</span>
        <span className="text-muted-foreground">
          {value.length === 0 ? "Any" : `${value.length} selected`}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
        {visible.length === 0 ? (
          <DropdownMenuItem disabled>No labels among these pull requests</DropdownMenuItem>
        ) : (
          visible.map((option) => {
            const key = option.name.toLowerCase();
            return (
              <DropdownMenuCheckboxItem
                key={key}
                checked={selected.has(key)}
                onCheckedChange={(next) =>
                  onChange(
                    next
                      ? [...value, option.name].slice(0, 10)
                      : value.filter((name) => name.toLowerCase() !== key),
                  )
                }
              >
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{option.count}</span>
              </DropdownMenuCheckboxItem>
            );
          })
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** How many filters are narrowing the list, for the Filters button's count. */
export function activeFilterCount(filters: PullRequestLocalFilters): number {
  return (
    [filters.draft, filters.review, filters.checks, filters.author].filter(Boolean).length +
    (filters.labels?.length ?? 0)
  );
}

export function PullRequestFiltersMenu({
  filters,
  onFilters,
  authors,
  labels,
  typedDraft,
}: {
  filters: PullRequestLocalFilters;
  onFilters: (filters: PullRequestLocalFilters) => void;
  authors: readonly PullRequestAuthorFacet[];
  labels: readonly PullRequestLabelFacet[];
  /** A `draft:` typed in the search, which outranks the menu's and is shown
   *  in its place. */
  typedDraft?: PullRequestLocalFilters["draft"];
}) {
  const count = activeFilterCount(filters);
  const update = (next: Partial<PullRequestLocalFilters>) => {
    const merged = { ...filters, ...next };
    onFilters(
      Object.fromEntries(
        Object.entries(merged).filter(([, value]) =>
          Array.isArray(value) ? value.length > 0 : value !== undefined,
        ),
      ) as PullRequestLocalFilters,
    );
  };
  const pick = <K extends "draft" | "review" | "checks">(key: K, value: string) =>
    update({ [key]: value === UNFILTERED ? undefined : value } as Partial<PullRequestLocalFilters>);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={count > 0 ? "secondary" : "ghost"}
            size="sm"
            aria-label={count > 0 ? `Filters, ${count} on` : "Filters"}
            title="Filters"
          >
            <ListFilter aria-hidden className="size-3.5" />
            {count > 0 ? <span className="tabular-nums">{count}</span> : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="w-60">
        <AuthorSubmenu
          value={filters.author}
          options={authors}
          onChange={(author) => update({ author })}
        />
        <LabelSubmenu
          value={filters.labels ?? []}
          options={labels}
          onChange={(next) => update({ labels: next })}
        />
        <DropdownMenuSeparator />
        <RadioSubmenu
          label="Draft"
          value={typedDraft ?? filters.draft ?? UNFILTERED}
          options={DRAFT_OPTIONS}
          onChange={(value) => pick("draft", value)}
        />
        <RadioSubmenu
          label="Review"
          value={filters.review ?? UNFILTERED}
          options={REVIEW_OPTIONS}
          onChange={(value) => pick("review", value)}
        />
        <RadioSubmenu
          label="Checks"
          value={filters.checks ?? UNFILTERED}
          options={CHECKS_OPTIONS}
          onChange={(value) => pick("checks", value)}
        />
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          Or type label:, -label:, author:, draft:, review: or checks:
        </DropdownMenuLabel>
        {count > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onFilters({})}>
              <CircleX aria-hidden className={cn("size-3.5")} />
              Clear filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
