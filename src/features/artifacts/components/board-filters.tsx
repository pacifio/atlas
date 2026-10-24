/**
 * The board's scope, as three pills in the header: Project, Agent, People.
 *
 * A pill per question rather than one menu behind a funnel icon. The funnel
 * hid both the question and the answer — you could not tell the board was
 * narrowed without opening it — and these say what they are scoped to on
 * their face: `Project | All`, `Agent | Any`, `People | Anyone`.
 *
 * Counts are against the whole board, not the filtered view. A menu whose
 * every option reads "0" the moment you narrow is a menu that cannot be used
 * to find anything.
 */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  projectFilterFor,
  projectFilterKey,
  type BoardSession,
  type ProjectFilter,
} from "../types";
import { agentLabel } from "../lib/board";
import { authorOf, type AuthorDirectory } from "../lib/author-directory";

/**
 * The pill: a quiet label welded to a bright value, split by a hairline.
 *
 * One control, not two — the label is not clickable on its own — so the whole
 * thing is the target and the value never looks like a separate button.
 */
export function CompoundFilter({
  label,
  children,
  ...props
}: React.ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      data-slot="compound-filter"
      {...props}
      className={cn(
        "group inline-flex h-7 shrink-0 cursor-pointer items-center overflow-hidden rounded-full",
        "border border-border bg-[var(--card)] text-xs outline-none",
        "transition-colors duration-fast hover:bg-element-hover",
        props.className,
      )}
    >
      <span className="border-r border-border/70 px-2.5 text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 px-2.5 font-medium text-foreground">{children}</span>
    </button>
  );
}

/** One option in a filter menu: a name, how many sessions it has, a tick. */
function Option({
  selected,
  count,
  onSelect,
  children,
}: {
  selected: boolean;
  count?: number;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem onClick={onSelect}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && (
        <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">{count}</span>
      )}
      <Check
        size={12}
        className={cn("shrink-0 text-foreground", !selected && "invisible")}
        aria-hidden={!selected}
      />
    </DropdownMenuItem>
  );
}

/** How many sessions each value of `pick` has, in descending order. */
function tally<T extends string>(
  sessions: BoardSession[],
  pick: (s: BoardSession) => T | null,
): { value: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const s of sessions) {
    const v = pick(s);
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, z) => z.count - a.count);
}

export function BoardFilters({
  sessions,
  directory,
  projectFilter,
  onProjectFilter,
  agentFilter,
  onAgentFilter,
  peopleFilter,
  onPeopleFilter,
}: {
  /** Every row the board holds, BEFORE narrowing — so the counts are honest. */
  sessions: BoardSession[];
  directory: AuthorDirectory;
  projectFilter: ProjectFilter | null;
  onProjectFilter: (filter: ProjectFilter | null) => void;
  agentFilter: string | null;
  onAgentFilter: (agent: string | null) => void;
  /** Author ids; empty is "anyone". `null` stands for your own rows. */
  peopleFilter: (string | null)[];
  onPeopleFilter: (people: (string | null)[]) => void;
}) {
  // Keyed on the folder when there is one and the server id when there is
  // not, so a teammate's Project with no checkout here is choosable too.
  const filterOf = new Map<string, ProjectFilter>();
  const nameOf = new Map<string, string>();
  for (const s of sessions) {
    const f = projectFilterFor(s);
    if (!f) continue;
    const key = projectFilterKey(f);
    if (!filterOf.has(key)) {
      filterOf.set(key, f);
      nameOf.set(key, s.projectName);
    }
  }
  const projects = tally(sessions, (s) => {
    const f = projectFilterFor(s);
    return f ? projectFilterKey(f) : null;
  });
  const selectedKey = projectFilter ? projectFilterKey(projectFilter) : null;
  const projectName = (key: string, fallback: ProjectFilter) =>
    nameOf.get(key) ?? ("local" in fallback ? fallback.local : fallback.remote);
  const agents = tally(sessions, (s) => s.agent);

  // People are keyed by author id, and `null` — your own local rows — is a
  // real key rather than a missing one, so it round-trips through a Set.
  const SELF = "\u0000self";
  const peopleCounts = new Map<string, number>();
  for (const s of sessions) {
    const k = s.authorId ?? SELF;
    peopleCounts.set(k, (peopleCounts.get(k) ?? 0) + 1);
  }
  const people = [...peopleCounts.entries()]
    .map(([key, count]) => ({ key, count, author: authorOf(key === SELF ? null : key, directory) }))
    .sort((a, z) => z.count - a.count);
  const chosen = new Set(peopleFilter.map((p) => p ?? SELF));

  const peopleLabel =
    chosen.size === 0
      ? "Anyone"
      : chosen.size === 1
        ? (people.find((p) => chosen.has(p.key))?.author.label ?? "1 person")
        : `${chosen.size} people`;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <CompoundFilter label="Project" aria-label="Filter by project">
              <span className="max-w-40 truncate">
                {projectFilter === null || selectedKey === null
                  ? "All"
                  : projectName(selectedKey, projectFilter)}
              </span>
              <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
            </CompoundFilter>
          }
        />
        <DropdownMenuContent align="end" className="min-w-52">
          <Option selected={projectFilter === null} onSelect={() => onProjectFilter(null)}>
            All projects
          </Option>
          {projects.map((p) => (
            <Option
              key={p.value}
              selected={selectedKey === p.value}
              count={p.count}
              onSelect={() =>
                onProjectFilter(selectedKey === p.value ? null : (filterOf.get(p.value) ?? null))
              }
            >
              {projectName(p.value, filterOf.get(p.value)!)}
            </Option>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <CompoundFilter label="Agent" aria-label="Filter by agent">
              <span className="max-w-32 truncate">
                {agentFilter === null ? "Any" : agentLabel(agentFilter)}
              </span>
              <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
            </CompoundFilter>
          }
        />
        <DropdownMenuContent align="end" className="min-w-48">
          <Option selected={agentFilter === null} onSelect={() => onAgentFilter(null)}>
            Any agent
          </Option>
          {agents.map((a) => (
            <Option
              key={a.value}
              selected={agentFilter === a.value}
              count={a.count}
              onSelect={() => onAgentFilter(agentFilter === a.value ? null : a.value)}
            >
              {agentLabel(a.value)}
            </Option>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <CompoundFilter label="People" aria-label="Filter by person">
              {/* The faces when a few are chosen: who is selected is read
                  faster from their photos than from a count. */}
              {chosen.size > 0 && chosen.size <= 3 && (
                <span className="flex items-center -space-x-1">
                  {people
                    .filter((p) => chosen.has(p.key))
                    .map(
                      (p) =>
                        p.author.avatar && (
                          <span key={p.key} className="rounded-full ring-2 ring-[var(--card)]">
                            <AccountAvatar user={p.author.avatar} size={14} />
                          </span>
                        ),
                    )}
                </span>
              )}
              <span className="max-w-32 truncate">{peopleLabel}</span>
              <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
            </CompoundFilter>
          }
        />
        <DropdownMenuContent align="end" className="min-w-52">
          <Option selected={chosen.size === 0} onSelect={() => onPeopleFilter([])}>
            Anyone
          </Option>
          {people.map((p) => (
            <Option
              key={p.key}
              selected={chosen.has(p.key)}
              count={p.count}
              // Multi-select: people is the one filter where "these two" is a
              // real question, so a pick toggles rather than replaces.
              onSelect={() => {
                const next = new Set(chosen);
                if (next.has(p.key)) next.delete(p.key);
                else next.add(p.key);
                onPeopleFilter([...next].map((k) => (k === SELF ? null : k)));
              }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {p.author.avatar && <AccountAvatar user={p.author.avatar} size={16} />}
                <span className="truncate">{p.author.avatar?.name || p.author.label}</span>
              </span>
            </Option>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
