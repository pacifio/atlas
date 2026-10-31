// The small pieces a sidebar row is made of: the project badge, the agent
// mark, the working ring and its timer, the relative time.
//
// Each is cheap on purpose. The list mounts a window of rows at a time and
// re-renders a row only when its own props change, so a clock in any of
// these must tick by itself — one shared one-second ticker for every timer
// on screen, one shared minute ticker for every age — and never through the
// row.

import { useSyncExternalStore, type ReactNode } from "react";
import {
  AgentMonogram,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  ExternalAgentIcon,
  KiloIcon,
  OpenCodeIcon,
} from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { useChatStore } from "@/features/chat/stores/chat-store";
import type { SidebarAgent } from "@/features/chat/lib/sidebar-agents";
import { cn } from "@/lib/utils";
import { snoozeRemainingLabel } from "@/features/chat/lib/session-snooze";
import { compactAge } from "../lib/session-row-status";
import {
  projectMonogram,
  projectMonogramColor,
  useProjectIcon,
} from "@/features/projects/lib/project-icon";

/**
 * The project's badge, the size of an icon: the icon the project ships (its
 * favicon or app icon) when it has one, else its monogram on a tile tinted
 * with the project's colour. Pass `path` to look the icon up; without it the
 * badge is always the monogram.
 */
export function ProjectBadge({
  name,
  path,
  className,
}: {
  name: string;
  path?: string | null;
  className?: string;
}) {
  const icon = useProjectIcon(path);
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        aria-hidden
        draggable={false}
        className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
      />
    );
  }
  const color = projectMonogramColor(name);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm font-mono text-3xs font-bold leading-none tracking-tighter",
        className,
      )}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {projectMonogram(name)}
    </span>
  );
}

/** How many attached projects get a badge of their own before "…" stands in
 *  for the rest. */
const MAX_ATTACHED_BADGES = 2;

/** One badge laid over the one before it. The badge fill is a translucent
 *  tint, so an opaque base goes under it: without one the initials beneath
 *  show through and the two read as a smudge. */
function StackedBadge({ children }: { children: ReactNode }) {
  return (
    <span className="-ms-1.5 shrink-0 rounded-sm bg-background ring-1 ring-border">{children}</span>
  );
}

/** The session's project badge, with the projects attached to it stacked
 *  after it: their initials, overlapping, two at most and "…" past that.
 *  Their names are the stack's title; the hover card lists them with their
 *  access. */
export function ProjectBadgeStack({
  name,
  path,
  attached,
  attachedNames,
}: {
  name: string;
  path?: string | null;
  attached: readonly { displayName: string; path?: string }[];
  attachedNames: string;
}) {
  if (attached.length === 0) return <ProjectBadge name={name} path={path} />;
  const shown = attached.slice(0, MAX_ATTACHED_BADGES);
  return (
    <span title={`${name}, with ${attachedNames} attached`} className="flex shrink-0 items-center">
      <ProjectBadge name={name} path={path} />
      {shown.map((project, i) => (
        <StackedBadge key={`${i}-${project.displayName}`}>
          <ProjectBadge name={project.displayName} path={project.path} />
        </StackedBadge>
      ))}
      {attached.length > MAX_ATTACHED_BADGES && (
        <StackedBadge>
          <span
            aria-hidden
            className="grid size-4 place-items-center rounded-sm bg-element-selected text-3xs font-semibold leading-none text-muted-foreground"
          >
            …
          </span>
        </StackedBadge>
      )}
    </span>
  );
}

/** A row listed under a project filter because that project is attached to
 *  it, not because the session runs there. */
export function AttachedMark() {
  return (
    <span
      title="The filtered project is attached to this session"
      className="ms-1.5 shrink-0 text-2xs font-normal text-muted-foreground"
    >
      attached
    </span>
  );
}

/** The mark of the agent that ran a session. */
export function SessionAgentIcon({
  agent,
  className,
}: {
  agent: SidebarAgent;
  className?: string;
}) {
  const size = cn("size-3", className);
  if (agent === "codex") return <CodexIcon className={size} />;
  if (agent === "opencode") return <OpenCodeIcon className={size} />;
  if (agent === "cursor") return <CursorIcon className={size} />;
  if (agent === "kilo") return <KiloIcon className={size} />;
  if (agent === "atlas-agent") return <AtlasIcon size={12} className={className} />;
  if (agent === "claude") return <ClaudeIcon className={size} />;
  const meta = agentMeta(agent);
  return meta.iconDataUrl ? (
    <ExternalAgentIcon dataUrl={meta.iconDataUrl} size={12} />
  ) : (
    <AgentMonogram label={meta.label} size={12} />
  );
}

// ── Clocks ─────────────────────────────────────────────────────────────────
//
// Module-level tickers: one interval however many labels are on screen,
// running only while something listens and paused while the window is
// hidden (a hidden label has nobody to show the second to).

function makeTicker(periodMs: number) {
  const listeners = new Set<() => void>();
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    now = Date.now();
    for (const listener of listeners) listener();
  };
  const start = () => {
    if (timer === null && !document.hidden) timer = setInterval(tick, periodMs);
  };
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (document.hidden) stop();
    else {
      tick();
      start();
    }
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        now = Date.now();
        document.addEventListener("visibilitychange", onVisibility);
        start();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
          document.removeEventListener("visibilitychange", onVisibility);
        }
      };
    },
    get: () => now,
  };
}

const secondTicker = makeTicker(1_000);
const minuteTicker = makeTicker(60_000);

/** "45s", "7m", "1h 5m" — how long the current turn has run. */
export function formatWorkingDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** The running turn's clock, from the start the chat store stamped on the tab.
 *  Nothing for a turn running somewhere else: there is no start to count from. */
export function WorkingDuration({ tabId }: { tabId: string | null }) {
  const startedAt = useChatStore((s) =>
    tabId ? (s.sessions[tabId]?.turnStartedAt ?? null) : null,
  );
  if (startedAt === null) return null;
  return <WorkingDurationLabel startedAt={startedAt} />;
}

function WorkingDurationLabel({ startedAt }: { startedAt: number }) {
  const now = useSyncExternalStore(secondTicker.subscribe, secondTicker.get);
  return <span className="tabular-nums">{formatWorkingDuration(now - startedAt)}</span>;
}

/** "now", "5m", "3h" — ticking by itself once a minute. */
export function RelativeTime({ iso }: { iso: string | null }) {
  const now = useSyncExternalStore(minuteTicker.subscribe, minuteTicker.get);
  return <>{compactAge(iso, now)}</>;
}

/** How long until a snooze ends ("45m", "3h", "2d"), on the same minute tick. */
export function SnoozeRemaining({ until }: { until: string }) {
  const now = useSyncExternalStore(minuteTicker.subscribe, minuteTicker.get);
  return <>{snoozeRemainingLabel(until, new Date(now))}</>;
}

/** The dashed ring that turns while an agent works. */
export function WorkingRing({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      // A continuous, deliberately slow rotation — the stock `animate-spin` at
      // 1s reads as "loading" rather than "working" — and no slow-spin token
      // exists. Reduced motion stops it.
      className={cn(
        "size-3.5 shrink-0 animate-spin [animation-duration:3s] motion-reduce:animate-none",
        className,
      )}
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.6 2.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Lucide's `circle-dashed-check`, drawn here: it is not in the pinned lucide.
 *  The arcs are lucide's own `circle-dashed`, plus its standard check, so the
 *  finished session wears the working ring, closed. */
export function CircleDashedCheck({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
      <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
      <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
      <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
      <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
      <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
      <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
      <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
