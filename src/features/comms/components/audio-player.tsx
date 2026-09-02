import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Download, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { ArcProgress } from "./arc-progress";

/**
 * A compact audio block: play/pause, a seekable waveform, mute, download.
 *
 * The waveform is REAL where it can be — the file is decoded once through
 * WebAudio and folded into per-bar peaks — and honest where it cannot:
 * WKWebView's decoder does not always take a webm/opus container, and when
 * `decodeAudioData` refuses, the bars fall back to a uniform ridge that still
 * shows played-vs-remaining. Peaks are cached per src so a re-mount (tab
 * switch, list re-render) never re-decodes.
 *
 * `src` may be null until the caller has buffered the file locally; the play
 * button then shows the caller's download arc instead of a control that
 * would not work.
 */

const BARS = 40;

const peakCache = new Map<string, number[]>();

async function decodePeaks(src: string): Promise<number[] | null> {
  const cached = peakCache.get(src);
  if (cached) return cached;
  try {
    const buf = await (await fetch(src)).arrayBuffer();
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const stride = Math.max(1, Math.floor(data.length / BARS));
      const peaks: number[] = [];
      for (let i = 0; i < BARS; i++) {
        let max = 0;
        const from = i * stride;
        const to = Math.min(data.length, from + stride);
        // Sample within the bucket rather than scanning every frame — a
        // 10-minute track is ~50M samples and this runs on the main thread.
        const step = Math.max(1, Math.floor((to - from) / 200));
        for (let j = from; j < to; j += step) {
          const v = Math.abs(data[j]);
          if (v > max) max = v;
        }
        peaks.push(max);
      }
      const top = Math.max(0.01, ...peaks);
      const scaled = peaks.map((p) => Math.max(0.12, p / top));
      peakCache.set(src, scaled);
      return scaled;
    } finally {
      void ctx.close();
    }
  } catch {
    return null;
  }
}

function formatTime(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export const AudioPlayer = memo(function AudioPlayer({
  src,
  filename,
  subtitle,
  buffering,
  bufferProgress,
  onRequestSrc,
  onDownload,
}: {
  /** Local playable URL, or null while not yet buffered. */
  src: string | null;
  filename: string;
  /** Small right-side label — typically the byte size. */
  subtitle?: string;
  /** True while the caller is buffering the file for us. */
  buffering?: boolean;
  bufferProgress?: { got: number; total: number };
  /** Called when play is hit before `src` exists. */
  onRequestSrc?: () => void;
  onDownload?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  // Set when the user hit play before the file was local; consumed on arrival.
  const wantsPlay = useRef(false);

  useEffect(() => {
    if (!src) return;
    let live = true;
    void decodePeaks(src).then((p) => {
      if (live && p) setPeaks(p);
    });
    return () => {
      live = false;
    };
  }, [src]);

  // Autoplay once the requested file lands.
  useEffect(() => {
    if (src && wantsPlay.current) {
      wantsPlay.current = false;
      void audioRef.current?.play().catch(() => {});
    }
  }, [src]);

  const toggle = useCallback(() => {
    if (!src) {
      wantsPlay.current = true;
      onRequestSrc?.();
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, [src, onRequestSrc]);

  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = frac * el.duration;
    setTime(el.currentTime);
  }, []);

  const frac = duration > 0 ? time / duration : 0;
  const bars = peaks ?? UNIFORM;

  return (
    <div className="flex w-full max-w-[420px] items-center gap-2 rounded-lg border border-border-default bg-bg-elevated px-2.5 py-2">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          muted={muted}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setTime(0);
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        />
      )}

      <button
        type="button"
        onClick={toggle}
        disabled={buffering}
        title={playing ? "Pause" : "Play"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-active text-text-primary transition-colors hover:bg-bg-hover cursor-pointer"
      >
        {buffering ? (
          <span className="text-[var(--comms-unread)]">
            <ArcProgress got={bufferProgress?.got ?? 0} total={bufferProgress?.total ?? 0} />
          </span>
        ) : playing ? (
          <Pause size={12} />
        ) : (
          <Play size={12} className="ml-px" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          role="slider"
          aria-label={`Seek ${filename}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(frac * 100)}
          onClick={seek}
          className={cn("flex h-[26px] items-center gap-px", src ? "cursor-pointer" : "opacity-60")}
        >
          {bars.map((p, i) => {
            const played = (i + 0.5) / BARS <= frac;
            return (
              <span
                key={i}
                className={cn(
                  "min-w-0 flex-1 rounded-full transition-colors duration-100",
                  played ? "bg-[var(--comms-unread)]" : "bg-border-strong",
                )}
                style={{ height: `${Math.round(4 + p * 18)}px` }}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[9.5px] tabular-nums text-text-ghost">
            {formatTime(time)} / {formatTime(duration)}
          </span>
          {subtitle && <span className="text-[9.5px] text-text-ghost">{subtitle}</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          title={muted ? "Unmute" : "Mute"}
          onClick={() => setMuted((v) => !v)}
          className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
        >
          {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>
        {onDownload && (
          <button
            type="button"
            title="Download"
            onClick={onDownload}
            className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
          >
            <Download size={12} />
          </button>
        )}
      </div>
    </div>
  );
});

/** The honest fallback when the container cannot be decoded: a flat ridge. */
const UNIFORM: number[] = Array.from({ length: BARS }, () => 0.45);
