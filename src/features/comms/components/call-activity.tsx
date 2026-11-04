import { memo, useCallback, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { comms, parseRefusal } from "../lib/comms-api";
import { copyShareLink, memberCallUrl } from "../lib/call-links";
import { useCommsStore } from "../stores/comms-store";
import { AudioPlayer } from "./audio-player";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatBytes } from "../lib/derive";
import type { ChatCall, OrgMemberProfile, RecordingTrack } from "../types";
import { CallActivityView } from "./views/call-activity-view";

/**
 * A call on the timeline: the container for `CallActivityView` (the row), with
 * the IPC, the dialogs and the recording fetch.
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

  return (
    <CallActivityView
      call={call}
      authorName={author?.name ?? "Someone"}
      recordingOpen={open}
      onRecordingToggle={toggle}
      recording={{
        status: loading ? "loading" : tracks !== null ? "ready" : "idle",
        tracks: tracks ?? EMPTY_TRACKS,
      }}
      renderTrack={(t) => <TrackRow key={t.id} track={t} />}
      onCopyLink={() => void copyShareLink(orgId, call)}
      onJoin={() => void joinCall(orgId, call.id)}
      onSaveTranscript={() => void saveTranscript(call.id)}
    />
  );
});

const EMPTY_TRACKS: RecordingTrack[] = [];

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
