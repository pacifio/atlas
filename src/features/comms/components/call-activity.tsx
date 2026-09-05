import { memo, useCallback, useState } from "react";
import { ChevronDown, ExternalLink, FileText, Link2, Loader2, Phone, Video } from "lucide-react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { comms, parseRefusal } from "../lib/comms-api";
import { copyShareLink, memberCallUrl } from "../lib/call-links";
import { useCommsStore } from "../stores/comms-store";
import { AudioPlayer } from "./audio-player";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatClock } from "../lib/derive";
import type { ChatCall, OrgMemberProfile, RecordingTrack } from "../types";

/**
 * A call, rendered as a Linear-style activity row rather than a message bubble.
 *
 * A call is not something anyone said, so it does not get a bubble, an avatar
 * column of its own, or a hover toolbar — it is an *update* on the timeline:
 * icon gutter, one muted sentence. (It once drew a Linear-style connector line
 * between consecutive calls; removed — it fought the gutter alignment.)
 *
 * Recordings are deliberately NOT fetched with the row. Their URLs are minted
 * for ~60 seconds, so a URL fetched at render is expired by the time anyone
 * clicks it; the tracks are asked for when the disclosure opens.
 */
export const CallActivity = memo(function CallActivity({
  call,
  author,
}: {
  call: ChatCall;
  author: OrgMemberProfile | null;
}) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<RecordingTrack[] | null>(null);
  const [loading, setLoading] = useState(false);
  const orgId = useCommsStore((s) => s.connection.orgId) ?? "";

  const live = call.ended_at === null;
  const hasRecording = call.recording_state === "ready";

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (!next || !hasRecording) return;
    // Always re-fetch: the previous set of URLs has almost certainly expired.
    setLoading(true);
    comms
      .callRecordings(call.id)
      .then((r) => setTracks(r.tracks))
      .catch((e) => {
        console.warn("comms: recordings failed:", call.id, e);
        toast.error("Could not load that recording.");
        setOpen(false);
      })
      .finally(() => setLoading(false));
  }, [open, hasRecording, call.id]);

  const who = author?.name ?? "Someone";
  const verb = live ? "started" : "ended";
  const kind = call.mode === "video" ? "video call" : "call";
  const Icon = call.mode === "video" ? Video : Phone;

  return (
    <div className="group/call relative flex gap-2 px-3 py-[3px]">
      <div className="flex w-9 shrink-0 justify-center">
        <span
          className={cn(
            "relative z-[1] mt-[3px] flex h-5 w-5 items-center justify-center rounded-full border",
            live
              ? "border-white/25 bg-white/10 text-text-primary"
              : "border-border-subtle bg-bg-elevated text-text-tertiary",
          )}
        >
          <Icon size={11} />
        </span>
      </div>

      <div className="min-w-0 flex-1 py-[2px]">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] leading-[18px] text-text-tertiary">
          <span className="text-text-secondary">{who}</span>
          <span>
            {verb} a {kind}
          </span>
          {!live && call.ended_at !== null && (
            <span className="text-text-ghost">
              · {formatDuration(call.started_at, call.ended_at)}
            </span>
          )}
          {live && (
            <span className="rounded-full bg-white/10 px-1.5 py-px text-[10px] font-medium text-text-primary">
              Ongoing
            </span>
          )}
          {call.recording_state === "recording" && (
            <span className="rounded-full bg-bg-elevated px-1.5 py-px text-[10px] font-medium text-text-tertiary">
              Recording
            </span>
          )}
          {call.recording_state === "processing" && (
            <span className="rounded-full bg-bg-elevated px-1.5 py-px text-[10px] font-medium text-text-tertiary">
              Processing
            </span>
          )}
          {call.recording_state === "failed" && (
            <span className="rounded-full bg-bg-elevated px-1.5 py-px text-[10px] font-medium text-status-error">
              Recording failed
            </span>
          )}
          <span className="text-text-ghost">{formatClock(call.started_at)}</span>

          {/* Row actions: the log carries the meeting link. Join only while
              the room is still open. */}
          {live && (
            <button
              type="button"
              title="Join this call in your browser"
              onClick={() => void joinCall(orgId, call.id)}
              className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <ExternalLink size={10} />
              Join
            </button>
          )}
          <button
            type="button"
            title={call.join_slug !== null ? "Copy the guest link" : "Copy the call link"}
            onClick={() => void copyShareLink(orgId, call)}
            className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-text-secondary opacity-0 transition-all hover:bg-bg-hover hover:text-text-primary group-hover/call:opacity-100"
          >
            <Link2 size={10} />
            Copy link
          </button>
        </div>

        {/* Transcript: the state IS the live update (frames patch it); when
            ready the CSV is one save away. Wording mirrors the web's card. */}
        {call.transcript_state === "pending" && (
          <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-text-tertiary">
            <Loader2 size={10} className="animate-spin" />
            Transcript is being produced…
          </span>
        )}
        {call.transcript_state === "failed" && (
          <span className="mt-0.5 block text-[10.5px] text-text-ghost">
            No transcript arrived for this call.
          </span>
        )}
        {call.transcript_state === "ready" && (
          <button
            type="button"
            onClick={() => void saveTranscript(call.id)}
            className="-ml-1 mt-0.5 flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <FileText size={11} />
            Save transcript
          </button>
        )}

        {hasRecording && (
          <button
            type="button"
            onClick={toggle}
            className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 -ml-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
          >
            <ChevronDown
              size={11}
              className={cn("transition-transform", open ? "rotate-0" : "-rotate-90")}
            />
            Recording
          </button>
        )}

        {open && hasRecording && (
          <div className="mt-1 flex flex-col gap-1">
            {loading && (
              <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                <Loader2 size={11} className="animate-spin" />
                Preparing links…
              </span>
            )}
            {!loading && (tracks ?? []).map((t) => <TrackRow key={t.id} track={t} />)}
            {!loading && tracks?.length === 0 && (
              <span className="text-[11px] text-text-ghost">No tracks were kept.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * One recorded track, as an audio block rather than a bare download row.
 *
 * Playback cannot stream from `track.url` — the ticket dies in sixty seconds
 * and a seek would range-request a dead link — so hitting play buffers the
 * file into the local cache first (the arc in the play button is that
 * download) and the `<audio>` element points at the cached copy.
 */
function TrackRow({ track }: { track: RecordingTrack }) {
  const progress = useCommsStore((s) => s.downloads[track.id]);
  const [path, setPath] = useState<string | null>(null);

  const fetchLocal = useCallback(() => {
    comms
      .fetchRecording(track.url, track.id, track.filename)
      .then((p) => setPath(p))
      .catch((e) => {
        console.warn("comms: recording buffer failed:", track.id, e);
        toast.error("Could not load that recording.");
      });
  }, [track.url, track.id, track.filename]);

  return (
    <AudioPlayer
      src={path ? convertFileSrc(path) : null}
      filename={track.filename}
      subtitle={formatBytes(track.bytes)}
      buffering={progress !== undefined}
      bufferProgress={progress}
      onRequestSrc={fetchLocal}
      onDownload={() => void saveTrack(track)}
    />
  );
}

async function joinCall(orgId: string, callId: string): Promise<void> {
  try {
    await openUrl(memberCallUrl(orgId, callId));
  } catch {
    toast.error("Could not open your browser.");
  }
}

async function saveTranscript(callId: string): Promise<void> {
  try {
    const dest = await saveFileDialog({ defaultPath: `transcript-${callId}.csv` });
    if (!dest) return;
    await comms.saveTranscript(callId, dest);
    toast.success("Transcript saved.");
  } catch (e) {
    const refusal = parseRefusal(e);
    toast.error(refusal?.message || "Could not save the transcript.");
  }
}

async function saveTrack(track: RecordingTrack): Promise<void> {
  try {
    const dest = await saveFileDialog({ defaultPath: track.filename });
    if (!dest) return;
    await comms.saveRecording(track.url, dest, track.id);
    toast.success("Recording saved.");
  } catch (e) {
    console.warn("comms: save recording failed:", track.id, e);
    toast.error("Could not save that recording.");
  }
}

/** Whole minutes above a minute, seconds below — the web log's phrasing. */
function formatDuration(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
