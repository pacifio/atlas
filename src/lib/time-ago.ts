// Relative-time formatter shared across the chat sidebar, inbox, bash-history,
// canvas notes, and the log. Consolidates five near-identical copies; the
// options reproduce each call site's exact prior output:
//   - `suffix`        → append " ago" to the m/h/d units (and seconds).
//   - `seconds`       → add a sub-minute "Ns" bucket (used by the log).
//   - `noDateFallback`→ keep showing "Nd[ ago]" past a week instead of a date.
export interface TimeAgoOptions {
  suffix?: boolean;
  seconds?: boolean;
  noDateFallback?: boolean;
}

export function timeAgo(iso: string | null | undefined, opts: TimeAgoOptions = {}): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const { suffix = false, seconds = false, noDateFallback = false } = opts;
  const ago = suffix ? " ago" : "";
  const diff = Date.now() - t;

  if (seconds) {
    const s = Math.floor(diff / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s${ago}`;
  }

  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m${ago}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${ago}`;
  const d = Math.floor(h / 24);
  if (noDateFallback || d < 7) return `${d}d${ago}`;
  // Older than a week → a human date. Drop the year for the current year
  // ("20 May"), include it otherwise ("20 May 2025"). Nicer than DD/MM/YYYY.
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    undefined,
    sameYear
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  );
}
