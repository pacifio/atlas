import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ExternalLink, Link2, Loader2, Phone, Users, Video } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { comms, parseRefusal } from "../lib/comms-api";
import { copyShareLink, memberCallUrl, shareUrl } from "../lib/call-links";
import { useCommsStore } from "../stores/comms-store";
import type { CallMode } from "../types";

/**
 * One header call button (audio or video): a blur menu, never an instant
 * dial. Two rows — call the channel, or call with a guest link. Starting
 * shows its progress in the row, then hands the user to the web call tab
 * (which mints its own join token; the desktop deliberately discards the
 * one the start answered — an unused mint burns a 30-minute reservation).
 *
 * If a live call already exists in this conversation, the rows become
 * Join / Copy link instead: the server runs no one-live-call check, and a
 * second start would be a second billable room.
 */
export function CallMenu({ convId, mode }: { convId: string; mode: CallMode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<"channel" | "guests" | null>(null);
  const orgId = useCommsStore((s) => s.connection.orgId);
  const liveCall = useCommsStore((s) => {
    for (const call of Object.values(s.calls)) {
      if (call.conv_id === convId && call.ended_at === null) return call;
    }
    return undefined;
  });

  const Icon = mode === "video" ? Video : Phone;
  const noun = mode === "video" ? "video call" : "call";

  const start = async (withGuests: boolean) => {
    if (pending || !orgId) return;
    setPending(withGuests ? "guests" : "channel");
    try {
      const call = await comms.startCall(convId, mode, withGuests);
      // Copy first: the guest door when one was minted, else the member URL.
      const copied = await copyText(shareUrl(orgId, call));
      // Then hand this user to the call itself, always via the member page.
      await openUrl(memberCallUrl(orgId, call.id)).catch(() => {
        toast.error("Could not open your browser — the link is on your clipboard.");
      });
      toast.success(copied ? "Call started — link copied." : "Call started.");
      setOpen(false);
    } catch (e) {
      const refusal = parseRefusal(e);
      toast.error(refusal?.message || "Could not start the call.");
    } finally {
      setPending(null);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return; // no dismissing mid-start; the row shows why
        setOpen(next);
      }}
    >
      {/* Tooltip OUTSIDE the popover trigger: both want `asChild`, and this
          nesting order is the one that keeps a single button element. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={mode === "video" ? "Start video call" : "Start voice call"}
              className={cn(
                "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
                open
                  ? "bg-bg-selected text-text-primary"
                  : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary",
              )}
            >
              <Icon size={13} />
            </button>
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {mode === "video" ? "Start video call" : "Start voice call"}
        </TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          style={{
            zIndex: 9999,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
          }}
          className="atlas-panel-in-tl select-none overflow-hidden rounded-xl border border-white/10 bg-[var(--bg-elevated)]/95 backdrop-blur-2xl"
        >
          <div className="flex w-[230px] flex-col py-1">
            {liveCall ? (
              <>
                <div className="px-3 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-text-tertiary">
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
              <>
                <MenuRow
                  icon={
                    pending === "channel" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Icon size={12} />
                    )
                  }
                  label={pending === "channel" ? "Starting…" : `Call channel`}
                  sub={`Start a ${noun} for members`}
                  disabled={pending !== null}
                  onClick={() => void start(false)}
                />
                <MenuRow
                  icon={
                    pending === "guests" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Users size={12} />
                    )
                  }
                  label={pending === "guests" ? "Starting…" : "Call with guests"}
                  sub="Anyone with the link can knock"
                  disabled={pending !== null}
                  onClick={() => void start(true)}
                />
              </>
            )}
          </div>
        </Popover.Content>
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
      className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-medium text-text-primary">{label}</span>
        {sub && (
          <span className="mt-px block text-[10px] leading-[1.4] text-text-tertiary">{sub}</span>
        )}
      </span>
    </button>
  );
}
