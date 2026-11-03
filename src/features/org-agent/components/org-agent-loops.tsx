// Loops: instructions Atlas runs for the member on a schedule or when
// something happens, posting one result each time. The web's `loops.tsx`.
//
// Creating one here is the approval of its one output, so the form spells out
// where it goes and the audience rule that follows from it: a Loop that posts
// where other people read only reads what all of them can see. The server
// checks the same, as the member, when the form is sent — and its refusals
// (`loops_max`, `not_a_poster`, a bad time zone) are shown in its own words.
//
// A Loop proposed in a conversation arrives as an approval card instead
// (`org-agent-turn.tsx`); approving it creates the Loop, which then shows here.

import { useEffect, useMemo, useState } from "react";
import { Pause, Play, Plus, Repeat, Trash2 } from "lucide-react";

import { useCommsStore } from "@/features/comms/stores/comms-store";
import { useOrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { timeAgo } from "@/lib/time-ago";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Select } from "@/ui/select";

import { OrgAgentError } from "../lib/org-agent-api";
import {
  LOOP_DAY_NAMES,
  LOOP_EVENT_KINDS,
  LOOP_EVENT_WORDS,
  loopTriggerWords,
  type CreateLoopRequest,
  type Loop,
  type LoopEventKind,
  type LoopOutput,
} from "../lib/org-agent-types";
import { useOrgAgentStore } from "../stores/org-agent-store";
import { Notice } from "./org-agent-turn";

/** Where a Loop posts, in the member's words. */
export function outputLabel(
  output: LoopOutput,
  names: { conv?: (id: string) => string; person?: (id: string) => string } = {},
): string {
  if (output.kind === "dm_self") return "A message to you";
  if (output.kind === "dm") return `A message to ${names.person?.(output.user_id) ?? "one person"}`;
  return `Posts in ${names.conv?.(output.conv_id) ?? "a channel"}`;
}

/** The audience rule, spelled out for an output. */
export function audienceRule(output: LoopOutput, where: string): string {
  if (output.kind === "dm_self") return "Only you read it, so it can use anything you can see.";
  if (output.kind === "dm")
    return "Someone else reads it, so it only reads what everyone in your organisation can see.";
  return `Posts to ${where}; reads only what everyone in ${where} can see.`;
}

const STATUS: Record<
  Loop["status"],
  { label: string; variant: "success" | "secondary" | "warning" }
> = {
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "secondary" },
  paused_cap: { label: "Paused for today", variant: "warning" },
  deleted: { label: "Deleted", variant: "secondary" },
};

function message(e: unknown, fallback: string): string {
  if (e instanceof OrgAgentError) {
    if (e.code === "loops_max") return "Your organisation has as many Loops as it can have.";
    if (e.code === "not_a_poster")
      return "You can only post a Loop's result in a channel you are in.";
    if (e.code === "loops_off") return "Loops are turned off for this organisation.";
    return e.message;
  }
  return fallback;
}

export function OrgAgentLoops() {
  const loops = useOrgAgentStore.use.loops();
  const loopsError = useOrgAgentStore.use.loopsError();
  const atlas = useOrgAgentStore.use.atlas();
  const connection = useOrgAgentStore.use.connection();
  const { loadLoops, setLoopStatus, deleteLoop, refreshStatus } = useOrgAgentStore.use.actions();
  const directory = useOrgDirectory();
  const conversations = useCommsStore((s) => s.conversations);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const me = directory.currentUserId;

  useEffect(() => {
    if (connection !== "open") return;
    void refreshStatus().then(() => loadLoops());
  }, [connection, loadLoops, refreshStatus]);

  const personName = (id: string) =>
    id === me ? "you" : (directory.byId.get(id)?.name ?? "a former member");
  const convName = (id: string) => {
    const c = conversations.find((x) => x.id === id);
    return c?.name ? `#${c.name}` : "a channel";
  };
  const list = (loops ?? []).filter((l) => l.status !== "deleted");
  const now = Date.now();

  const act = (fn: () => Promise<void>) => {
    setFailed(null);
    void fn().catch((e) => setFailed(message(e, "Atlas could not change that Loop.")));
  };

  return (
    <div
      className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 py-8"
      data-slot="org-agent-loops"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Loops</h2>
          <p className="text-xs text-muted-foreground">
            Instructions Atlas runs for you on a schedule or when something happens, posting one
            result each time.
          </p>
        </div>
        {!creating && atlas?.loops_enabled !== false && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={12} />
            New Loop
          </Button>
        )}
      </div>

      {atlas && !atlas.loops_enabled && (
        <Notice tone="info">Loops are turned off for this organisation.</Notice>
      )}
      {failed && <Notice tone="error">{failed}</Notice>}

      {creating && (
        <LoopForm
          channels={conversations
            .filter((c) => c.kind === "channel" && c.archived_at == null)
            .map((c) => ({ value: c.id, label: `#${c.name ?? c.id}` }))}
          people={[...directory.byId.values()]
            .filter((p) => p.userId !== me)
            .map((p) => ({ value: p.userId, label: p.name }))}
          onDone={() => setCreating(false)}
        />
      )}

      {loops === null ? (
        <div className="flex flex-col gap-2" aria-busy>
          <div className="h-16 animate-pulse rounded-lg bg-element-hover" />
          <div className="h-16 animate-pulse rounded-lg bg-element-hover" />
        </div>
      ) : loopsError && list.length === 0 ? (
        <Notice tone="error">{loopsError}</Notice>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <Repeat size={18} className="text-muted-foreground" />
          <p className="text-sm text-foreground">No Loops yet</p>
          <p className="max-w-[320px] text-xs text-muted-foreground">
            A Loop can send you a morning digest, or tell a channel when a checkpoint lands. Create
            one here, or ask Atlas to set one up.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border bg-card">
          {list.map((loop) => {
            const mine = loop.creator === me;
            return (
              <li
                key={loop.id}
                data-slot="org-agent-loop-row"
                className="flex items-start gap-3 px-3 py-2.5"
              >
                <Repeat size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {loop.name}
                    </span>
                    <Badge variant={STATUS[loop.status].variant}>{STATUS[loop.status].label}</Badge>
                    {!mine && (
                      <span className="text-2xs text-muted-foreground">
                        Loop by {personName(loop.creator)}
                      </span>
                    )}
                  </p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{loop.instruction}</p>
                  <p className="text-xs text-secondary-foreground">
                    {loopTriggerWords(
                      loop.trigger,
                      "events" in loop.trigger && loop.trigger.filters?.conv
                        ? { conv: convName(loop.trigger.filters.conv) }
                        : {},
                    )}
                    {" · "}
                    {outputLabel(loop.output, { conv: convName, person: personName })}
                  </p>
                  {loop.note && <p className="text-2xs text-warning">{loop.note}</p>}
                  <p className="flex flex-wrap gap-x-2 text-2xs tabular-nums text-muted-foreground">
                    <span>
                      {loop.runs_today} run{loop.runs_today === 1 ? "" : "s"} today
                    </span>
                    {loop.last_run_at && (
                      <span>
                        · Last ran{" "}
                        {timeAgo(new Date(loop.last_run_at).toISOString(), { suffix: true })}
                      </span>
                    )}
                    {loop.next_run_at && loop.status === "active" && loop.next_run_at > now && (
                      <span>· Next {new Date(loop.next_run_at).toLocaleString()}</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  {loop.status === "active" || loop.status === "paused_cap"
                    ? (mine || atlas?.admin) && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => act(() => setLoopStatus(loop.id, "paused"))}
                        >
                          <Pause size={10} />
                          Pause
                        </Button>
                      )
                    : mine && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => act(() => setLoopStatus(loop.id, "active"))}
                        >
                          <Play size={10} />
                          Resume
                        </Button>
                      )}
                  {mine &&
                    (confirming === loop.id ? (
                      <>
                        <Button
                          size="xs"
                          variant="destructive"
                          onClick={() => {
                            setConfirming(null);
                            act(() => deleteLoop(loop.id));
                          }}
                        >
                          Delete it
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button size="xs" variant="ghost" onClick={() => setConfirming(loop.id)}>
                        <Trash2 size={10} />
                        Delete
                      </Button>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type Option = { value: string; label: string };

/** Every IANA zone this webview knows, the member's own first. */
function timeZones(): string[] {
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let all: string[] = [];
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? [];
  } catch {
    all = [];
  }
  return [...new Set([own, "UTC", ...all])];
}

const EVERY: Option[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
];
const WHEN: Option[] = [
  { value: "schedule", label: "On a schedule" },
  { value: "events", label: "When something happens" },
];
const OUTPUT: Option[] = [
  { value: "dm_self", label: "Send me a message" },
  { value: "dm", label: "Send a person a message" },
  { value: "channel", label: "Post in a channel" },
];

/** The create form. Everything is picked, nothing typed as an id. */
export function LoopForm({
  channels,
  people,
  onDone,
}: {
  channels: Option[];
  people: Option[];
  onDone: () => void;
}) {
  const { createLoop } = useOrgAgentStore.use.actions();
  const zones = useMemo(timeZones, []);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [when, setWhen] = useState<"schedule" | "events">("schedule");
  const [every, setEvery] = useState<"hourly" | "daily" | "weekly">("daily");
  const [at, setAt] = useState("09:00");
  const [tz, setTz] = useState(zones[0]!);
  const [weekday, setWeekday] = useState("1");
  const [events, setEvents] = useState<LoopEventKind[]>(["checkpoint.created"]);
  const [watch, setWatch] = useState("any");
  const [outKind, setOutKind] = useState<"dm_self" | "dm" | "channel">("dm_self");
  const [person, setPerson] = useState(people[0]?.value ?? "");
  const [channel, setChannel] = useState(channels[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const output: LoopOutput | null =
    outKind === "dm_self"
      ? { kind: "dm_self" }
      : outKind === "dm"
        ? person
          ? { kind: "dm", user_id: person }
          : null
        : channel
          ? { kind: "channel", conv_id: channel }
          : null;
  const where =
    outKind === "channel"
      ? (channels.find((c) => c.value === channel)?.label ?? "the channel")
      : "";
  const needsChannel = when === "events" && events.includes("message.posted") && watch === "any";
  const valid =
    name.trim() !== "" &&
    instruction.trim() !== "" &&
    output !== null &&
    (when === "schedule" || (events.length > 0 && !needsChannel));

  const submit = async () => {
    if (!valid || !output || busy) return;
    const body: CreateLoopRequest = {
      name: name.trim(),
      instruction: instruction.trim(),
      trigger:
        when === "schedule"
          ? {
              schedule: {
                every,
                at,
                tz,
                ...(every === "weekly" ? { weekday: Number(weekday) } : {}),
              },
            }
          : { events, ...(watch !== "any" ? { filters: { conv: watch } } : {}) },
      output,
    };
    setBusy(true);
    setError(null);
    try {
      await createLoop(body);
      onDone();
    } catch (e) {
      setError(message(e, "Atlas could not create that Loop."));
    } finally {
      setBusy(false);
    }
  };

  const field = "flex min-w-0 flex-col gap-1.5";
  const label = "text-xs font-medium text-foreground";

  return (
    <form
      aria-label="New Loop"
      data-slot="org-agent-loop-form"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className={field}>
        <span className={label}>Name</span>
        <Input
          value={name}
          maxLength={120}
          placeholder="Morning digest"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className={field}>
        <span className={label}>What to do each time</span>
        <textarea
          value={instruction}
          maxLength={4000}
          rows={3}
          placeholder="Summarise yesterday's sessions and anything left open."
          onChange={(e) => setInstruction(e.target.value)}
          className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-border-strong"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <span className={label}>When it runs</span>
          <Select
            aria-label="When it runs"
            value={when}
            onValueChange={(v) => setWhen(v as typeof when)}
            options={WHEN}
          />
        </div>
        {when === "schedule" && (
          <div className={field}>
            <span className={label}>How often</span>
            <Select
              aria-label="How often"
              value={every}
              onValueChange={(v) => setEvery(v as typeof every)}
              options={EVERY}
            />
          </div>
        )}
      </div>

      {when === "schedule" ? (
        <div className="grid grid-cols-3 gap-3">
          {every === "weekly" && (
            <div className={field}>
              <span className={label}>On</span>
              <Select
                aria-label="Day"
                value={weekday}
                onValueChange={setWeekday}
                options={LOOP_DAY_NAMES.map((d, i) => ({ value: String(i), label: d }))}
              />
            </div>
          )}
          <label className={field}>
            <span className={label}>{every === "hourly" ? "Minutes past the hour" : "At"}</span>
            <Input type="time" value={at} onChange={(e) => setAt(e.target.value || "09:00")} />
          </label>
          <div className={field}>
            <span className={label}>Time zone</span>
            <Select
              aria-label="Time zone"
              value={tz}
              onValueChange={setTz}
              options={zones.map((z) => ({ value: z, label: z }))}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <fieldset className="flex flex-col gap-1.5">
            <legend className={`${label} mb-1`}>Run when</legend>
            {LOOP_EVENT_KINDS.map((kind) => (
              <label
                key={kind}
                className="flex items-center gap-2 text-xs text-secondary-foreground"
              >
                <input
                  type="checkbox"
                  checked={events.includes(kind)}
                  onChange={(e) =>
                    setEvents(
                      e.target.checked ? [...events, kind] : events.filter((x) => x !== kind),
                    )
                  }
                />
                <span className="first-letter:uppercase">{LOOP_EVENT_WORDS[kind]}</span>
              </label>
            ))}
          </fieldset>
          {events.includes("message.posted") && (
            <div className={field}>
              <span className={label}>Which channel</span>
              <Select
                aria-label="Which channel"
                value={watch}
                onValueChange={setWatch}
                options={[{ value: "any", label: "Any channel" }, ...channels]}
              />
            </div>
          )}
          {needsChannel && (
            <p className="text-2xs text-warning">Pick the channel to watch for new messages.</p>
          )}
          <p className="text-2xs text-muted-foreground">
            Activity within five minutes is handled in one run.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <span className={label}>Where the result goes</span>
          <Select
            aria-label="Where the result goes"
            value={outKind}
            onValueChange={(v) => setOutKind(v as typeof outKind)}
            options={OUTPUT}
          />
        </div>
        {outKind === "dm" && (
          <div className={field}>
            <span className={label}>Person</span>
            <Select
              aria-label="Person"
              value={person}
              onValueChange={setPerson}
              options={people}
              placeholder="Choose someone"
            />
          </div>
        )}
        {outKind === "channel" && (
          <div className={field}>
            <span className={label}>Channel</span>
            <Select
              aria-label="Channel"
              value={channel}
              onValueChange={setChannel}
              options={channels}
              placeholder="Choose a channel"
            />
          </div>
        )}
      </div>

      {output && <Notice tone="info">{audienceRule(output, where)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>
          {busy ? "Creating…" : "Create Loop"}
        </Button>
      </div>
    </form>
  );
}
