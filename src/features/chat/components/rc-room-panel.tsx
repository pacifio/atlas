// The remote-control room, as the owner runs it from the desktop: the panel
// the title bar's room pill opens (`rc-header-menu.tsx`). Every control the
// room has is here, the same set the web viewer's People panel offers its
// owner, plus the ones only the host can do:
//
//   Requests   a person asking to drive — Allow or Decline
//   Driving    who holds the seat; Take back control while it is not you
//   Here now   everyone connected, one row per person (their phone and laptop
//              folded together): Hand control, Remove
//   Invite     a shared room's teammates — invite from the Organisation,
//              withdraw an invite; Let teammates drive (their tier)
//   Requests   whether visitors may ask to drive at all
//   Share      a solo room, offered to the Organisation Atlas targets (once)
//   Link       the viewer link, and Copy
//   Stop       end the room (or Dismiss one that has ended)
//
// Laid out like the session reader's filter menu (`session-detail.tsx`): the
// theme's background as the ground, small uppercase section labels, and the
// raised popover grey only on the things you act on — a request, the link.
//
// Names and faces come from `useRcPeople`: the room sends ids, never a user's
// name. Who is invited is read when the panel opens and after an invite or a
// withdrawal — never on a timer, because that read wakes the room's server
// object.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Globe,
  Link as LinkIcon,
  Monitor,
  Plus,
  Search,
  ShipWheel,
  Smartphone,
  Hand,
  Square,
  Timer,
  Trash2,
  UserPlus,
  UserX,
  Users,
  X,
} from "lucide-react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { GlassIconButton } from "@/features/sidebar/components/glass-icon-button";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";
import { ScrollFade, useScrollEdges } from "@/ui/scroll-fade";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/switch";

import {
  rc,
  tierSteers,
  type RcLinkState,
  type RcMember,
  type RcPeer,
  type RcSurface,
} from "../lib/rc-api";
import { useRcPeople, type RcPeopleResolver } from "../lib/rc-people";
import type { RemoteControl } from "../lib/use-remote-control";

const SURFACE_ICON: Record<RcSurface, typeof Globe> = {
  web: Globe,
  mobile: Smartphone,
  desktop: Monitor,
};
const SURFACE_WORD: Record<RcSurface, string> = {
  web: "browser",
  mobile: "phone",
  desktop: "desktop",
};

const STATE_WORD: Record<RcLinkState, string> = {
  connecting: "Connecting",
  live: "Live",
  offline: "Reconnecting",
  ended: "Ended",
};
const STATE_DOT: Record<RcLinkState, string> = {
  connecting: "bg-warning",
  live: "bg-success",
  offline: "bg-warning",
  ended: "bg-[var(--muted-foreground)]",
};

const END_WORD: Record<string, string> = {
  closed_by_owner: "You ended it.",
  closed_by_admin: "An organisation admin ended it.",
  owner_timeout: "This desktop was away too long.",
  never_hosted: "This desktop never connected to it.",
  erased: "It was erased.",
  retention: "It expired.",
  deleted: "It was deleted; starting remote control again makes a new room.",
};

/** The scroll fades inside the panel: a ramp from its own ground. */
const FADE = "from-background via-background/80";

export function RcRoomPanel({ sessionId, remote }: { sessionId: string; remote: RemoteControl }) {
  const room = remote.room;
  const scopeOrgId = room?.scope?.orgId ?? null;
  const people = useRcPeople(scopeOrgId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(bodyRef, [room?.peers.length, room?.pending.length]);

  if (!room) return null;
  const ended = room.state === "ended";
  const driverId = room.driver?.id ?? null;

  return (
    <div className="flex max-h-[calc(100svh-5rem)] w-[320px] flex-col overflow-hidden">
      <header className="flex h-10 shrink-0 items-center gap-2 px-4 pt-1">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            STATE_DOT[room.state],
            room.state === "live" && "atlas-live-pulse",
          )}
          style={
            room.state === "live"
              ? {
                  ["--atlas-pulse-color" as string]:
                    "color-mix(in oklab, var(--status-success-foreground) 40%, transparent)",
                }
              : undefined
          }
        />
        <span className="text-sm text-foreground">Remote control</span>
        <span className="text-xs text-muted-foreground">· {STATE_WORD[room.state]}</span>
      </header>

      {/* Sized by its content and shrunk to the cap — not `flex-1`, whose zero
          basis under a max-height column cut the body short of the cap. */}
      <div className="relative flex min-h-0 shrink flex-col">
        <ScrollFade at="top" visible={edges.top} className={cn(FADE, "h-6")} />
        <ScrollFade at="bottom" visible={edges.bottom} className={cn(FADE, "h-6")} />
        <div
          ref={bodyRef}
          className="hide-scrollbar flex min-h-0 shrink flex-col gap-5 overflow-y-auto px-4 pt-2 pb-4"
        >
          {ended ? (
            <div>
              <p className="text-sm text-foreground">The room is closed</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {room.lastError ??
                  (room.endReason ? END_WORD[room.endReason] : null) ??
                  "The viewer link no longer opens it."}
              </p>
            </div>
          ) : (
            <>
              {room.pending.map((request) => {
                const person = people(request.fromId, request.fromName);
                return (
                  <div
                    key={request.requestId}
                    className="flex items-center gap-2 rounded-lg bg-popover px-3 py-2.5"
                  >
                    <AccountAvatar user={person.user} size={22} />
                    {/* First name: a long full name truncated the verb away. */}
                    <p
                      className="min-w-0 flex-1 truncate text-sm text-foreground"
                      title={`${person.label} asks to drive`}
                    >
                      {person.label.split(" ")[0]} asks to drive
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remote.answerControl(request.requestId, false)}
                    >
                      Decline
                    </Button>
                    <Button size="sm" onClick={() => remote.answerControl(request.requestId, true)}>
                      Allow
                    </Button>
                  </div>
                );
              })}

              <Driving remote={remote} people={people} />
              <HereNow
                peers={room.peers}
                driverId={driverId}
                people={people}
                remote={remote}
                live={room.state === "live"}
              />

              {room.scope ? (
                <Invite sessionId={sessionId} remote={remote} people={people} />
              ) : remote.shareWith ? (
                <section>
                  <Label icon={UserPlus}>Invite</Label>
                  <div className="mt-2 flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                      Share with {remote.shareWith.name} to invite its people.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={remote.busy}
                      onClick={remote.share}
                    >
                      Share
                    </Button>
                  </div>
                </section>
              ) : null}

              <section>
                <Label icon={Hand}>Seat</Label>
                {/* Segmented: the switches in one inset card, a hairline
                    between them — the project picker's list card
                    (`project-picker.tsx`). */}
                <div className="mt-2 flex flex-col overflow-hidden rounded-lg bg-background shadow-sm ring-1 ring-border">
                  {room.scope && (
                    <div className="border-b border-foreground/8 px-3 py-2.5">
                      <ToggleRow
                        label="Let teammates drive"
                        hint="Invited teammates can prompt and ask for the seat"
                        checked={remote.membersDrive}
                        disabled={remote.busy}
                        onCheckedChange={remote.setMembersDrive}
                      />
                    </div>
                  )}
                  <div className="px-3 py-2.5">
                    <ToggleRow
                      label="Accept requests to drive"
                      hint={
                        room.acceptRequests
                          ? "You allow or decline each ask"
                          : "Asks are declined as they arrive"
                      }
                      checked={room.acceptRequests}
                      disabled={remote.busy}
                      onCheckedChange={remote.setAcceptRequests}
                    />
                  </div>
                </div>
              </section>

              <LinkRow url={room.viewerUrl} onCopy={remote.copyLink} />
            </>
          )}
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
        <LiveFor startedAt={room.startedAt} ended={ended} />
        {ended ? (
          <span className="flex items-center gap-1.5">
            {/* Stop closes the door and the next start reopens the same room;
                Delete demolishes it. Offered after a stop too, or the next
                start would bring the old link and invites back. */}
            {room.endReason !== "deleted" && (
              <Button variant="ghost" size="sm" disabled={remote.busy} onClick={remote.remove}>
                <Trash2 size={12} />
                Delete room…
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={remote.dismiss}>
              <X size={12} />
              Dismiss
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <HintGroup side="top">
              <HintItem label="Delete room…">
                <IconButton
                  icon={Trash2}
                  label="Delete room…"
                  size="md"
                  shape="round"
                  disabled={remote.busy}
                  onClick={remote.remove}
                />
              </HintItem>
            </HintGroup>
            <button
              type="button"
              disabled={remote.busy}
              onClick={remote.stop}
              // The label is short for the eye; the name stays whole for the ear.
              aria-label="Stop remote control"
              className={cn(
                "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-destructive px-3.5 text-xs font-medium",
                // ratchet-allow: white ink on the saturated red fill in every theme; the theme's
                // destructive-foreground is black in the dark themes, which made the label unreadable.
                "text-white",
                "transition-opacity duration-fast hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Square size={10} fill="currentColor" />
              Stop RC
            </button>
          </span>
        )}
      </footer>
    </div>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

function Driving({ remote, people }: { remote: RemoteControl; people: RcPeopleResolver }) {
  const driver = remote.room?.driver ?? null;
  const person = driver ? people(driver.id, driver.name) : null;
  return (
    <section>
      <Label icon={ShipWheel}>Driving</Label>
      <div className="mt-2 flex h-8 items-center gap-2.5">
        {person ? (
          <>
            <AccountAvatar user={person.user} size={22} />
            <p className="min-w-0 flex-1 truncate text-sm text-foreground">
              {person.label}
              {person.isYou && <span className="text-muted-foreground"> · you</span>}
              {driver?.lost && <span className="text-muted-foreground"> · reconnecting</span>}
            </p>
            {remote.remoteDriver && (
              <Button size="sm" disabled={remote.busy} onClick={remote.takeOver}>
                Take back control
              </Button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Waiting for the room…</p>
        )}
      </div>
    </section>
  );
}

function HereNow({
  peers,
  driverId,
  people,
  remote,
  live,
}: {
  peers: RcPeer[];
  driverId: string | null;
  people: RcPeopleResolver;
  remote: RemoteControl;
  live: boolean;
}) {
  return (
    <section>
      <Label icon={Users} count={live && peers.length > 0 ? peers.length : undefined}>
        Here now
      </Label>
      {!live || peers.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {live ? "No one has the link open yet." : "Shown again once the room reconnects."}
        </p>
      ) : (
        <HintGroup side="top">
          <ul className="mt-1.5 flex flex-col">
            {peers.map((peer) => {
              const person = people(peer.id, peer.name);
              const driving = peer.id === driverId;
              // The owner's own phone or browser is you: nothing to hand, no
              // one to remove.
              const yours = person.isYou || peer.role === "owner";
              return (
                <li key={peer.id} className="flex h-9 items-center gap-2.5">
                  <AccountAvatar user={person.user} size={22} />
                  <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
                    <span className="truncate">{person.isYou ? "You" : person.label}</span>
                    {peer.surfaces.map((surface) => {
                      const Glyph = SURFACE_ICON[surface];
                      return (
                        <Glyph
                          key={surface}
                          size={11}
                          className="shrink-0 text-muted-foreground"
                          aria-label={`on ${SURFACE_WORD[surface]}`}
                        />
                      );
                    })}
                  </p>
                  {peer.role === "owner" && <Tag>Owner</Tag>}
                  {driving && <Tag tone="live">Driving</Tag>}
                  {peer.kind !== "user" && <Tag>Guest</Tag>}
                  {!yours && (
                    <span className="flex shrink-0 items-center">
                      {!driving && tierSteers(peer.tier) && (
                        <HintItem label={`Hand control to ${person.label}`}>
                          <IconButton
                            icon={ShipWheel}
                            label={`Hand control to ${person.label}`}
                            size="sm"
                            shape="round"
                            disabled={remote.busy}
                            onClick={() => remote.grant(peer.id, person.label)}
                          />
                        </HintItem>
                      )}
                      <HintItem label={`Remove ${person.label}`}>
                        <IconButton
                          icon={UserX}
                          label={`Remove ${person.label}`}
                          size="sm"
                          shape="round"
                          disabled={remote.busy}
                          onClick={() => remote.kick(peer.id, person.label)}
                        />
                      </HintItem>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </HintGroup>
      )}
    </section>
  );
}

function Invite({
  sessionId,
  remote,
  people,
}: {
  sessionId: string;
  remote: RemoteControl;
  people: RcPeopleResolver;
}) {
  const scopeOrgId = remote.room?.scope?.orgId ?? null;
  const roster = useMembersStore((s) => (scopeOrgId ? s.byOrg[scopeOrgId]?.members : undefined));
  const [invited, setInvited] = useState<RcMember[] | null>(null);
  const [choice, setChoice] = useState("");
  const [working, setWorking] = useState(false);

  // Read on open and after our own changes — never polled: the read wakes
  // the room on the server.
  const reload = useCallback(() => {
    rc.members(sessionId)
      .then(setInvited)
      .catch(() => setInvited((current) => current ?? []));
  }, [sessionId]);
  useEffect(reload, [reload]);

  const invitedIds = useMemo(() => new Set((invited ?? []).map((m) => m.userId)), [invited]);
  const options = useMemo(
    () =>
      (roster ?? [])
        .filter((m) => !people(m.userId).isYou && !invitedIds.has(m.userId))
        .map((m) => {
          const person = people(m.userId);
          return {
            value: m.userId,
            label: person.label,
            icon: <AccountAvatar user={person.user} size={16} />,
          };
        }),
    [roster, invitedIds, people],
  );

  const send = async () => {
    if (!choice || working) return;
    setWorking(true);
    const ok = await remote.invite(choice, people(choice).label);
    setWorking(false);
    if (ok) {
      setChoice("");
      reload();
    }
  };

  const revoke = async (userId: string) => {
    setWorking(true);
    const ok = await remote.revokeInvite(userId, people(userId).label);
    setWorking(false);
    if (ok) reload();
  };

  return (
    <section>
      <Label icon={UserPlus} count={invited && invited.length > 0 ? invited.length : undefined}>
        Invite
      </Label>
      {/* The sidebar's search row (`sidebar-session-header.tsx`): a rounded
          field with its glyph, and the glass round button beside it. */}
      <div className="mt-2 flex items-center gap-2">
        <Select
          value={choice}
          onValueChange={setChoice}
          options={options}
          placeholder={
            choice ? undefined : options.length ? "Choose a teammate" : "Everyone's invited"
          }
          disabled={options.length === 0 || working}
          size="md"
          shape="pill"
          leading={<Search size={13} />}
          indicator={false}
          aria-label="Teammate to invite"
          className="min-w-0 flex-1"
        />
        <GlassIconButton
          icon={Plus}
          label="Invite"
          disabled={!choice || working}
          onClick={() => void send()}
          className="size-control-md"
        />
      </div>
      {invited && invited.length > 0 && (
        <HintGroup side="top">
          <ul className="mt-3 flex flex-col">
            {invited.map((member) => {
              const person = people(member.userId);
              return (
                <li key={member.userId} className="flex h-9 items-center gap-2.5">
                  <AccountAvatar user={person.user} size={20} />
                  <span className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">
                    {person.label}
                  </span>
                  <Tag>{member.joinedAt ? "Joined" : "Invited"}</Tag>
                  <HintItem label={`Withdraw ${person.label}'s invite`}>
                    <IconButton
                      icon={X}
                      label={`Withdraw ${person.label}'s invite`}
                      size="sm"
                      shape="round"
                      disabled={working}
                      onClick={() => void revoke(member.userId)}
                    />
                  </HintItem>
                </li>
              );
            })}
          </ul>
        </HintGroup>
      )}
    </section>
  );
}

function LinkRow({ url, onCopy }: { url: string; onCopy: () => void }) {
  return (
    <div className="flex h-9 items-center gap-2 rounded-full bg-popover pr-1 pl-3.5">
      <LinkIcon size={12} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-secondary-foreground">
        {url.replace(/^https?:\/\//, "")}
      </span>
      {/* The share sheet's copy button (`share-morph.tsx`), so the two link
          rows in the app look and act alike. */}
      <button
        type="button"
        onClick={onCopy}
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-3 text-2xs font-medium text-background transition-opacity duration-fast hover:opacity-85"
      >
        <LinkIcon size={12} />
        Copy link
      </button>
    </div>
  );
}

/** How long the room has been open — "1m 30s" — from the server's creation
 *  stamp. Ticks each second while the panel is open (it only mounts then). */
function LiveFor({ startedAt, ended }: { startedAt: number; ended: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ended) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ended]);
  if (ended || !startedAt) return <span />;
  const elapsed = liveFor(now - startedAt);
  return (
    <span
      className="flex items-center gap-1.5 text-xs leading-none text-secondary-foreground tabular-nums"
      aria-label={`Live for ${elapsed}`}
    >
      {/* Up a pixel: the stopwatch's dial sits below its box's centre (the
          crown takes the top), so centred by the box it read low. */}
      <Timer size={12} className="-translate-y-px text-muted-foreground" aria-hidden />
      <span>{elapsed}</span>
    </span>
  );
}

/** A room's age as a running clock: "45s", "1m 30s", "1h 2m 5s". */
export function liveFor(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

/** The filter menu's section label: small caps, a glyph before it and the
 *  count after, a step quieter than the rows it heads. */
function Label({
  children,
  count,
  icon: Glyph,
}: {
  children: React.ReactNode;
  count?: number;
  icon: typeof Globe;
}) {
  return (
    <p className="flex items-center gap-1.5">
      <Glyph size={12} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-2xs leading-none font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {children}
      </span>
      {count !== undefined && (
        <span className="font-mono text-2xs leading-none text-muted-foreground">{count}</span>
      )}
    </p>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    // A div, not a <label>: Base UI names a switch inside a label by the
    // label's whole text, hint included, over its own aria-label.
    <div className="flex items-center gap-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        <span className="block truncate text-2xs text-muted-foreground">{hint}</span>
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "live" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px text-3xs font-medium",
        tone === "live" ? "border-success/40 text-success" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
