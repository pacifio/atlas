import type { ReactNode } from "react";
import { ChevronDown, ExternalLink, FileText, Phone, Video } from "lucide-react";
import {
  Badge,
  Button,
  Icon,
  Spinner,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { formatClock, formatDuration } from "../../lib/derive";
import type { ChatCall, RecordingTrack } from "../../types";

export interface CallActivityViewProps {
  call: ChatCall;
  /** The starter's name; "Someone" when unresolved. */
  authorName: string;
  recordingOpen: boolean;
  onRecordingToggle: () => void;
  recording: { status: "idle" | "loading" | "ready"; tracks: RecordingTrack[] };
  renderTrack: (track: RecordingTrack) => ReactNode;
  onCopyLink: () => void;
  onJoin: () => void;
  onSaveTranscript: () => void;
}

/**
 * A call, rendered as a Linear-style activity row rather than a message bubble.
 *
 * A call is not something anyone said, so it does not get a bubble, an avatar
 * column of its own, or a hover toolbar — it is an *update* on the timeline:
 * icon gutter, one muted sentence.
 */
export function CallActivityView({
  call,
  authorName,
  recordingOpen,
  onRecordingToggle,
  recording,
  renderTrack,
  onCopyLink,
  onJoin,
  onSaveTranscript,
}: CallActivityViewProps) {
  const live = call.ended_at === null;
  const hasRecording = call.recording_state === "ready";
  const verb = live ? "started" : "ended";
  const kind = call.mode === "video" ? "video call" : "call";

  return (
    <div data-view="call-activity" className="relative flex gap-2 px-3 py-0.5">
      <div className="flex w-9 shrink-0 justify-center">
        <span
          className={cn(
            "mt-0.5 flex size-5 items-center justify-center rounded-full border",
            live
              ? "border-border-strong bg-element-active text-foreground"
              : "border-border-subtle bg-card text-muted-foreground",
          )}
        >
          <Icon icon={call.mode === "video" ? Video : Phone} size="xs" />
        </span>
      </div>

      <div className="min-w-0 flex-1 py-0.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-snug text-muted-foreground">
          {/* The sentence IS the share link. A hover-revealed "Copy link"
              button used to sit at the end of this row; because the row wraps,
              revealing it pushed the transcript line and the recording
              disclosure down by a line the moment the pointer arrived. The
              affordance now lives on text that is always there, so nothing
              moves — the tooltip is what says it is clickable. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onCopyLink}
                  // A tooltip trigger takes layout only, so the hover/focus
                  // underline is drawn by the span inside it.
                  className="group/link cursor-pointer text-left"
                >
                  <span className="underline-offset-2 group-hover/link:underline group-focus-visible/link:underline">
                    {/* Both halves brighten together: the name carries its own
                      colour, so a hover rule on the button alone would lift the
                      verb and leave the name behind. */}
                    <span className="text-secondary-foreground transition-colors duration-fast group-hover/link:text-foreground">
                      {authorName}
                    </span>{" "}
                    <span className="transition-colors duration-fast group-hover/link:text-foreground">
                      {verb} a {kind}
                    </span>
                  </span>
                </button>
              }
            />
            <TooltipContent side="top">
              {call.join_slug !== null
                ? "Click to copy the guest link"
                : "Click to copy the call link"}
            </TooltipContent>
          </Tooltip>
          {!live && call.ended_at !== null && (
            <span className="text-disabled">
              · {formatDuration(call.started_at, call.ended_at)}
            </span>
          )}
          {live && (
            <Badge variant="success" size="sm">
              <StatusDot tone="success" />
              Ongoing
            </Badge>
          )}
          {call.recording_state === "recording" && (
            <Badge variant="secondary" size="sm">
              Recording
            </Badge>
          )}
          {call.recording_state === "processing" && (
            <Badge variant="secondary" size="sm">
              Processing
            </Badge>
          )}
          {call.recording_state === "failed" && (
            <Badge variant="destructive" size="sm">
              Recording failed
            </Badge>
          )}
          <span className="text-disabled tabular-nums">{formatClock(call.started_at)}</span>

          {/* Row actions: the log carries the meeting link. Join only while
              the room is still open. */}
          {live && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="xs" onClick={onJoin}>
                    <Icon icon={ExternalLink} size="xs" />
                    Join
                  </Button>
                }
              />
              <TooltipContent side="top">Join this call in your browser</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Transcript: the state IS the live update (frames patch it); when
            ready the CSV is one save away. Wording mirrors the web's card. */}
        {call.transcript_state === "pending" && (
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner size="xs" label="" />
            Transcript is being produced…
          </span>
        )}
        {call.transcript_state === "failed" && (
          <span className="mt-0.5 block text-xs text-disabled">
            No transcript arrived for this call.
          </span>
        )}
        {call.transcript_state === "ready" && (
          <div className="-ml-1 mt-0.5 flex">
            <Button variant="ghost" size="xs" onClick={onSaveTranscript}>
              <Icon icon={FileText} size="sm" />
              Save transcript
            </Button>
          </div>
        )}

        {hasRecording && (
          // A plain disclosure button, as today: the package Collapsible's
          // aria-expanded/aria-controls wiring is a D24 proposal (ATL-718).
          <div className="-ml-1 mt-1 flex">
            <Button variant="ghost" size="xs" onClick={onRecordingToggle}>
              <span
                className={cn(
                  "flex transition-transform duration-fast",
                  recordingOpen ? "rotate-0" : "-rotate-90",
                )}
              >
                <Icon icon={ChevronDown} size="sm" />
              </span>
              Recording
            </Button>
          </div>
        )}

        {recordingOpen && hasRecording && (
          <div className="mt-1 flex flex-col gap-1">
            {recording.status === "loading" && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner size="sm" label="" />
                Preparing links…
              </span>
            )}
            {recording.status === "ready" && recording.tracks.map(renderTrack)}
            {recording.status === "ready" && recording.tracks.length === 0 && (
              <span className="text-xs text-disabled">No tracks were kept.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
