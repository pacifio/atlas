// 6-month install trend for the skills registry's Discover table.
//
// # What is real here and what is not
//
// The registry's `search` API returns a single lifetime `installs` count per
// skill and no time series at all (see the DATA NOTE in skills-marketplace).
// So the TOTAL is real and the SHAPE over time is synthesized: a deterministic
// split of that real total across the window, stable per skill id across
// renders and restarts.
//
// That is a deliberately stronger position than the agents' equivalent
// (`features/agents/lib/download-trends`), whose magnitude is invented too —
// here the curve always adds up to a number the registry actually reported, so
// its heights are relative shares of something true.
//
// # The path to real data
//
// Every skill install already captures a `skill_downloaded` PostHog event
// (`commands/skills.rs`), the same way an agent install captures
// `acp_agent_installed`. Neither is READ back yet — Atlas's PostHog client is
// write-only (capture), and querying would need a separate read credential. When
// that lands, a backend rollup replaces `installTrend` wholesale: the chart
// component only ever sees `{ points, total, up }`.

/** Weekly buckets over ~6 months. Weekly rather than monthly because the mark is
 *  an area curve: six points would render as a coarse zig-zag, and the shape is
 *  the whole point of the column. */
export const TREND_BUCKETS = 26;

export interface InstallTrend {
  /** Installs per bucket, oldest → newest. Sums to `total`. */
  points: number[];
  /** The registry's real lifetime count — what the row's number shows. */
  total: number;
  /** Newest bucket vs oldest; drives the mark's polarity color. */
  up: boolean;
}

/** Small fast deterministic PRNG (mulberry32) seeded from a string.
 *  Same generator the agent trends use — a shared seed function, not shared
 *  data, so the two surfaces cannot drift in "stable per id" behaviour. */
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

/** Share of skills whose curve declines over the window. */
const DECLINING_SHARE = 0.35;
/** Drift is clamped so `1 + drift` stays comfortably positive — a weight of zero
 *  would flatten the tail of the curve into the baseline. */
const MIN_DRIFT = -0.75;

/** Split a skill's real lifetime installs into a plausible 6-month curve.
 *
 *  Each skill gets its OWN drift, up or down, seeded from its id. That is what
 *  makes the column worth looking at: the mark is colored by polarity
 *  (`TrendSparkline` — green rising, red falling), so a drift that was always
 *  positive rendered every single row green and the color carried no
 *  information. Most skills still rise, because a lifetime counter on a young
 *  registry does imply recent adoption — but roughly a third fall.
 *
 *  The jitter is smoothed against the previous bucket so the curve wanders
 *  instead of spiking: the mark is an area chart, and uncorrelated noise would
 *  render as a hairball.
 *
 *  The result is exact: the apportionment below guarantees the curve sums to
 *  `total`. */
export function installTrend(id: string, total: number): InstallTrend {
  if (!Number.isFinite(total) || total <= 0) {
    return { points: Array.from({ length: TREND_BUCKETS }, () => 0), total: 0, up: false };
  }
  const next = rng(id);
  // Drawn FIRST, so a skill's direction depends only on its id and not on how
  // many buckets the window happens to have.
  const drift = next() < DECLINING_SHARE ? MIN_DRIFT + next() * 0.35 : 0.3 + next() * 0.9;
  const weights: number[] = [];
  let walk = 0.7 + next() * 0.6;
  for (let i = 0; i < TREND_BUCKETS; i++) {
    // Smooth the random walk toward its previous value, then apply the drift.
    walk = walk * 0.72 + (0.7 + next() * 0.6) * 0.28;
    weights.push(walk * (1 + (i / TREND_BUCKETS) * drift));
  }
  const sum = weights.reduce((a, b) => a + b, 0);

  // Largest-remainder apportionment: floor every bucket, then hand the leftover
  // units to the largest fractional parts. Exact by construction and never
  // negative, at any total.
  //
  // Rounding each bucket and letting the last one absorb the difference does NOT
  // work here: across 26 buckets a small total (say 13 installs) gives each
  // bucket a share below 1, every one of them rounds UP, and the last bucket has
  // to go negative to compensate — clamping it at zero then silently breaks the
  // "bars sum to the number on the row" invariant.
  const exact = weights.map((w) => (w / sum) * total);
  const points = exact.map(Math.floor);
  let remainder = total - points.reduce((a, b) => a + b, 0);
  const byFraction = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0; k++, remainder--) {
    points[byFraction[k % byFraction.length].i]++;
  }

  return {
    points,
    total,
    up: points[points.length - 1] >= points[0],
  };
}
