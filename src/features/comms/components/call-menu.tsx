import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ExternalLink, Link2, Loader2, Phone, Users, Video } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { comms, parseRefusal } from "../lib/comms-api";
import { copyShareLink, memberCallUrl, shareUrl } from "../lib/call-links";
import { callButtonPlan, NO_CALLS_REASON, NO_MEETINGS_REASON } from "../lib/call-plan";
import { useCallFeatures } from "../lib/use-call-features";
import { useCommsStore } from "../stores/comms-store";
import type { CallMode, CallProvider } from "../types";

/** One row of the start menu: what it starts, and how it reads. */
interface StartOption {
  key: string;
  provider: CallProvider;
  isPublic: boolean;
  guestIcon: boolean;
  label: string;
  sub: string;
}

/**
 * The rows a header button offers, per {@link callButtonPlan}. The phone is a
 * free Voice Call (`mesh`) wherever the plan has one, with an audio Meeting
 * behind it only for its guest link; the camera is always a Meeting (`rtk`).
 * `null` means the plan rules this button out.
 */
function startOptions(
  mode: CallMode,
  plan: ReturnType<typeof callButtonPlan>,
  meshMax: number | null,
): StartOption[] | null {
  if (mode === "video") {
    if (!plan.video) return null;
    return [
      {
        key: "channel",
        provider: "rtk",
        isPublic: false,
        guestIcon: false,
        label: "Call channel",
        sub: "Start a video call for members",
      },
      {
        key: "guests",
        provider: "rtk",
        isPublic: true,
        guestIcon: true,
        label: "Call with guests",
        sub: "Anyone with the link can knock",
      },
    ];
  }
  if (plan.phone === null) return null;
  if (plan.phone.kind === "voice") {
    const rows: StartOption[] = [
      {
        key: "voice",
        provider: "mesh",
        isPublic: false,
        guestIcon: false,
        label: "Start voice call",
        sub: `Members of this conversation${meshMax ? `, up to ${meshMax}` : ""}`,
      },
    ];
    if (plan.phone.guestMeeting) {
      rows.push({
        key: "guests",
        provider: "rtk",
        isPublic: true,
        guestIcon: true,
        label: "Meeting with guest link",
        sub: "People outside Atlas knock; a host lets them in",
      });
    }
    return rows;
  }
  return [
    {
      key: "channel",
      provider: "rtk",
      isPublic: false,
      guestIcon: false,
      label: "Call channel",
      sub: "Start a call for members",
    },
    {
      key: "guests",
      provider: "rtk",
      isPublic: true,
      guestIcon: true,
      label: "Call with guests",
      sub: "Anyone with the link can knock",
    },
  ];
}

/**
 * One header call button (audio or video): a blur menu, never an instant
 * dial. What the rows start follows the Organisation's plan, as the web
 * client draws it (`callButtonPlan`): the phone starts a free Voice Call, and
 * Meetings — the camera, and the phone's guest-link row — need `calls.paid`.
 * A button the plan rules out is drawn disabled with the reason on hover.
 *
 * Every start names its `provider`: the server reads a start without one as
 * a paid Meeting, so an Organisation without Meetings was refused on both
 * buttons and could only start a Voice Call from the web.
 *
 * Starting shows its progress in the row, then hands the user to the web
 * call tab (which mints its own join token; the desktop deliberately discards
 * the one a Meeting start answered — an unused mint burns a 30-minute
 * reservation).
 *
 * If a live call already exists in this conversation, the rows become
 * Join / Copy link instead: a second Meeting start would be a second
 * billable room (a second Voice Call start answers with the live one).
 */
export function CallMenu({ convId, mode }: { convId: string; mode: CallMode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const orgId = useCommsStore((s) => s.connection.orgId);
  const liveCall = useCommsStore((s) => {
    for (const call of Object.values(s.calls)) {
      if (call.conv_id === convId && call.ended_at === null) return call;
    }
    return undefined;
  });
  const features = useCallFeatures(orgId);
  const options = startOptions(
    mode,
    callButtonPlan(features?.features),
    features?.mesh_call_max ?? null,
  );

  const Icon = mode === "video" ? Video : Phone;
  const label = mode === "video" ? "Start video call" : "Start voice call";

  const start = async (option: StartOption) => {
    if (pending || !orgId) return;
    setPending(option.key);
    try {
      const call = await comms.startCall(convId, mode, option.isPublic, option.provider);
      // Copy first: the guest door when one was minted, else the member URL.
      const copied = await copyText(shareUrl(orgId, call));
      // Then hand this user to the call itself, always via the member page.
      await openUrl(memberCallUrl(orgId, call.id)).catch(() => {
        toast.error("Could not open your browser — the link is on your clipboard.");
      });
      const what = option.provider === "mesh" ? "Voice call" : "Call";
      toast.success(copied ? `${what} started — link copied.` : `${what} started.`);
      setOpen(false);
    } catch (e) {
      const refusal = parseRefusal(e);
      toast.error(refusal?.message || "Could not start the call.");
    } finally {
      setPending(null);
    }
  };

  // Ruled out by the plan, and nothing live to join: a disabled button that
  // says why. `aria-disabled` rather than `disabled`, because a disabled
  // button fires no pointer events and the tooltip would never show.
  if (options === null && !liveCall) {
    const reason = mode === "video" ? NO_MEETINGS_REASON : NO_CALLS_REASON;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-disabled="true"
              aria-label={`${label} — ${reason}`}
              className="flex h-7 w-7 shrink-0 cursor-not-allowed items-center justify-center rounded-md text-muted-foreground opacity-50"
            >
              <Icon size={13} />
            </button>
          }
        />
        <TooltipContent side="bottom" sideOffset={4}>
          {reason}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return; // no dismissing mid-start; the row shows why
        setOpen(next);
      }}
    >
      {/* Tooltip OUTSIDE the popover trigger: both want to render the same
          element, and this nesting order is the one that keeps a single
          button. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Popover.Trigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  className={cn(
                    "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
                    open
                      ? "bg-element-selected text-foreground"
                      : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
                  )}
                >
                  <Icon size={13} />
                </button>
              }
            />
          }
        />
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup className="atlas-panel-in-tl select-none overflow-hidden rounded-xl border border-border bg-[var(--card)]/95 backdrop-blur-2xl shadow-lg inset-highlight">
            <div className="flex w-[230px] flex-col py-1">
              {liveCall ? (
                <>
                  <div className="px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    A call is already live here
                  </div>
                  <MenuRow
                    icon={<ExternalLink size={12} />}
                    label="Join ongoing call"
                    onClick={() => {
                      void openUrl(memberCallUrl(orgId ?? "", liveCall.id)).catch(() =>
                        toast.error("Could not open your browser."),
                      );
                      setOpen(false);
                    }}
                  />
                  <MenuRow
                    icon={<Link2 size={12} />}
                    label="Copy call link"
                    onClick={() => {
                      void copyShareLink(orgId ?? "", liveCall);
                      setOpen(false);
                    }}
                  />
                </>
              ) : (
                (options ?? []).map((option) => (
                  <MenuRow
                    key={option.key}
                    icon={
                      pending === option.key ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : option.guestIcon ? (
                        <Users size={12} />
                      ) : (
                        <Icon size={12} />
                      )
                    }
                    label={pending === option.key ? "Starting…" : option.label}
                    sub={option.sub}
                    disabled={pending !== null}
                    onClick={() => void start(option)}
                  />
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MenuRow({
  icon,
  label,
  sub,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--atlas-element-hover)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        {sub && (
          <span className="mt-px block text-2xs leading-[1.4] text-muted-foreground">{sub}</span>
        )}
      </span>
    </button>
  );
}
