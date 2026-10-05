import { Globe, Monitor } from "lucide-react";

import { Badge } from "@/ui/badge";
import { avatarHue } from "@/features/comms/lib/derive";

import type { SharedPeer, SyncState } from "../lib/shared-threads-api";

const SYNC: Record<SyncState, { label: string; variant: "success" | "secondary" | "warning"; hint: string }> = {
  current: { label: "Up to date", variant: "success", hint: "This replica has everything the thread has." },
  syncing: { label: "Syncing", variant: "secondary", hint: "Your changes are on their way." },
  behind: {
    label: "Behind",
    variant: "warning",
    hint: "Offline — your saves are kept and sync when the connection is back.",
  },
};

/** Whether this replica is current, syncing or behind (ATL-407). */
export function SyncBadge({ sync, connected }: { sync: SyncState | null; connected: boolean }) {
  const state = SYNC[sync ?? (connected ? "current" : "behind")];
  return (
    <span title={state.hint}>
      <Badge variant={state.variant}>{state.label}</Badge>
    </span>
  );
}

/** Two letters for an avatar. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** One line on what somebody is doing, or `null` when nothing in particular. */
export function activity(peer: SharedPeer): string | null {
  if (peer.typing) return `typing in ${peer.typing}`;
  const run = peer.runs.find((r) => r.path);
  if (run) return `running an agent in ${run.path}`;
  if (peer.runs.length > 0) return "running an agent";
  return null;
}

/**
 * Who else is on the thread (ATL-407): an avatar per person — on a desktop or
 * the web — and what each is doing.
 */
export function PresenceBar({
  peers,
  nameOf = (userId) => userId,
}: {
  peers: SharedPeer[];
  /** A person's name for their user id. */
  nameOf?: (userId: string) => string;
}) {
  if (peers.length === 0) return null;
  // One avatar per person, however many windows they have open — doing
  // whatever any of them is doing.
  const byUser = new Map<string, SharedPeer>();
  for (const p of peers) {
    const seen = byUser.get(p.userId);
    byUser.set(
      p.userId,
      seen
        ? { ...seen, typing: seen.typing ?? p.typing, runs: [...seen.runs, ...p.runs] }
        : p,
    );
  }
  const people = [...byUser.values()];
  const doing = people
    .map((p) => ({ p, what: activity(p) }))
    .filter((x): x is { p: SharedPeer; what: string } => x.what !== null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1" aria-label="Here now">
        {people.map((p) => {
          const Surface = p.surface === "web" ? Globe : Monitor;
          const what = activity(p);
          return (
            <span
              key={p.userId}
              title={`${nameOf(p.userId)} · ${p.surface === "web" ? "web" : "desktop"}${what ? ` · ${what}` : ""}`}
              // ratchet-allow: white initials on a collaborator's own saturated hue — the one
              // their caret uses — which is not a theme surface.
              className="relative inline-flex size-6 items-center justify-center rounded-full text-3xs font-medium text-white"
              // ratchet-allow: a collaborator's own hue, the same one their caret uses.
              style={{ background: `hsl(${avatarHue(p.userId)} 55% 45%)` }}
            >
              {initials(nameOf(p.userId))}
              <Surface
                size={9}
                className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[var(--background)] p-px text-[var(--muted-foreground)]"
              />
              {p.typing && (
                <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-[var(--primary)]" />
              )}
            </span>
          );
        })}
      </div>
      {doing.map(({ p, what }) => (
        <span key={p.userId} className="truncate text-[var(--muted-foreground)]">
          <span className="text-[var(--secondary-foreground)]">{nameOf(p.userId)}</span> is {what}
        </span>
      ))}
    </div>
  );
}
