// Mock download-trend series for the marketplace cards.
//
// This is the SEED for the real pipeline: every install already captures an
// `acp_agent_installed` PostHog event (commands/registry.rs), so once enough
// real data accrues a backend query can replace `seededSeries` wholesale —
// the chart component only sees `{ points, total, up }`. Until then the series
// is deterministic per agent id (stable across renders and restarts), weekly
// over the past 6 months, in the 800–1400 downloads band with a slight upward
// drift so most agents read as "trending", and the local install bumps the
// trailing point — the seed incrementing exactly the way the real counter will.

export interface DownloadTrend {
  /** Weekly download counts, oldest → newest (~26 points ≈ 6 months). */
  points: number[];
  /** Sum over the window, for the "12.4k" label. */
  total: number;
  /** Trend polarity: latest point vs the window's first (drives green/red). */
  up: boolean;
}

/** ~26 weekly buckets ≈ 6 months. */
const WEEKS = 26;
const MIN = 800;
const MAX = 1400;

/** Small fast deterministic PRNG (mulberry32) seeded from the agent id. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function downloadTrend(agentId: string, installed: boolean): DownloadTrend {
  const next = rng(agentId);
  // Random walk with a gentle upward drift, clamped to the seed band.
  const drift = 2 + next() * 8; // per-week upward bias
  let value = MIN + next() * (MAX - MIN) * 0.6;
  const points: number[] = [];
  for (let i = 0; i < WEEKS; i++) {
    value += drift + (next() - 0.5) * 120;
    points.push(Math.round(Math.min(MAX, Math.max(MIN, value))));
  }
  // The user's own install is one real download on the newest bucket.
  if (installed) points[points.length - 1] += 1;
  const total = points.reduce((sum, p) => sum + p, 0);
  return { points, total, up: points[points.length - 1] >= points[0] };
}

/** 32541 → "32.5k" for the card label. */
export function fmtDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
