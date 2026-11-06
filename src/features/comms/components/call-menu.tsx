import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { comms, parseRefusal } from "../lib/comms-api";
import { copyShareLink, memberCallUrl, shareUrl } from "../lib/call-links";
import { callButtonPlan, NO_CALLS_REASON, NO_MEETINGS_REASON } from "../lib/call-plan";
import { useCallFeatures } from "../lib/use-call-features";
import { useCommsStore } from "../stores/comms-store";
import type { CallMode, CallProvider } from "../types";
import { CallMenuView } from "./views/call-menu-view";

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

  return (
    <CallMenuView
      mode={mode}
      open={open}
      onOpenChange={(next) => {
        if (pending) return; // no dismissing mid-start; the row shows why
        setOpen(next);
      }}
      options={options}
      disabledReason={mode === "video" ? NO_MEETINGS_REASON : NO_CALLS_REASON}
      pending={pending}
      liveCall={liveCall !== undefined}
      onStart={(key) => {
        const option = options?.find((o) => o.key === key);
        if (option) void start(option);
      }}
      onJoinLive={() => {
        if (!liveCall) return;
        void openUrl(memberCallUrl(orgId ?? "", liveCall.id)).catch(() =>
          toast.error("Could not open your browser."),
        );
        setOpen(false);
      }}
      onCopyLiveLink={() => {
        if (!liveCall) return;
        void copyShareLink(orgId ?? "", liveCall);
        setOpen(false);
      }}
    />
  );
}
