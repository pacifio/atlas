/**
 * Generated identity art: a small piece of art, the same every time for the
 * same seed and different for every other.
 *
 * It stands in wherever something has an identity but no picture — a guest
 * who commented on a shared Session and has no account to carry a face. It is
 * drawn from an **id**, never a name, so a guest who renames themselves keeps
 * the mark their remarks already carry.
 *
 * The language is Atlas's own: a field of dots, like the dotted mark on the
 * marketing site, over a gradient. Four compositions share it —
 *
 *  - **halftone**: the grid, each dot sized by a travelling wave;
 *  - **orbit**: dots on two rings, swelling round each one;
 *  - **strata**: diagonal bands of dots, the mark's own rising strokes;
 *  - **bloom**: dots that grow toward a focal point.
 *
 * Everything is computed here, as data, so it is testable and the component
 * only has to draw it. Coordinates are in a 24×24 box.
 */

export type ArtPattern = "halftone" | "orbit" | "strata" | "bloom";

export interface ArtDot {
  x: number;
  y: number;
  r: number;
  /** Opacity, 0–1. */
  o: number;
}

export interface GeneratedArtSpec {
  pattern: ArtPattern;
  /** The background gradient's direction, in degrees. */
  angle: number;
  /** Three stops, light to deep, as CSS colours. */
  stops: readonly [string, string, string];
  /** Where the soft highlight sits, in the 24 box. */
  glow: { x: number; y: number };
  dots: Array<ArtDot>;
}

export const ART_BOX = 24;

const PATTERNS: ReadonlyArray<ArtPattern> = ["halftone", "orbit", "strata", "bloom"];

/** FNV-1a: a string to 32 bits, stable across platforms. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, well-mixed generator from one 32-bit seed. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

function oklch(l: number, c: number, h: number): string {
  return `oklch(${round(l)} ${round(c)} ${round(((h % 360) + 360) % 360)})`;
}

/**
 * A palette that always reads as one: three hues a short step apart (or,
 * one time in three, a split toward the complement), light to deep, so the
 * white dots keep their contrast on every one of them.
 */
function palette(rand: () => number): readonly [string, string, string] {
  const h = rand() * 360;
  const split = rand() < 1 / 3;
  const step = split ? 120 + rand() * 40 : 28 + rand() * 30;
  const turn = rand() < 0.5 ? 1 : -1;
  const deep = h + turn * step;
  // Yellows darken into olive, so a deep stop there stays lighter.
  const hue = ((deep % 360) + 360) % 360;
  const muddy = hue > 70 && hue < 125;
  return [
    oklch(0.8, 0.13, h),
    oklch(0.62, 0.18, h + turn * step * 0.5),
    oklch(muddy ? 0.5 : 0.4, muddy ? 0.11 : 0.15, deep),
  ];
}

const GRID = 6;
const CELL = ART_BOX / GRID;
const centre = (i: number) => CELL / 2 + i * CELL;

function halftone(rand: () => number): Array<ArtDot> {
  const fx = (rand() < 0.5 ? 1 : -1) * (0.45 + rand() * 0.35);
  const fy = 0.3 + rand() * 0.4;
  const phase = rand() * Math.PI * 2;
  const dots: Array<ArtDot> = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = centre(i);
      const y = centre(j);
      const wave = 0.5 + 0.5 * Math.sin(fx * x + fy * y + phase);
      dots.push({ x, y, r: round(0.35 + wave * 1.35), o: round(0.55 + wave * 0.4) });
    }
  }
  return dots;
}

function orbit(rand: () => number): Array<ArtDot> {
  const cx = 12 + (rand() - 0.5) * 4;
  const cy = 12 + (rand() - 0.5) * 4;
  const spin = rand() * Math.PI * 2;
  const dots: Array<ArtDot> = [{ x: round(cx), y: round(cy), r: 1.6, o: 0.95 }];
  for (const [radius, count] of [
    [4.2, 7],
    [8.2, 13],
  ] as const) {
    for (let k = 0; k < count; k++) {
      const a = spin + (k / count) * Math.PI * 2;
      const swell = 0.5 + 0.5 * Math.cos(a - spin);
      dots.push({
        x: round(cx + Math.cos(a) * radius),
        y: round(cy + Math.sin(a) * radius),
        r: round(0.45 + swell * 0.95),
        o: round(0.5 + swell * 0.45),
      });
    }
  }
  return dots;
}

function strata(rand: () => number): Array<ArtDot> {
  // Bands that rise to the right, like the mark's strokes.
  const period = 3 + Math.floor(rand() * 2);
  const width = period === 3 ? 2 : 2 + Math.floor(rand() * 2);
  const offset = Math.floor(rand() * period);
  const dots: Array<ArtDot> = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const band = (((i + j + offset) % period) + period) % period;
      if (band >= width) continue;
      const edge = band === 0 || band === width - 1;
      dots.push({ x: centre(i), y: centre(j), r: edge ? 1.05 : 1.4, o: edge ? 0.7 : 0.92 });
    }
  }
  return dots;
}

function bloom(rand: () => number): Array<ArtDot> {
  const fx = 4 + rand() * 16;
  const fy = 4 + rand() * 16;
  const reach = Math.hypot(24, 24) * 0.5;
  const dots: Array<ArtDot> = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = centre(i);
      const y = centre(j);
      const near = Math.max(0, 1 - Math.hypot(x - fx, y - fy) / reach);
      if (near < 0.08) continue;
      dots.push({ x, y, r: round(0.3 + near * 1.55), o: round(0.45 + near * 0.5) });
    }
  }
  return dots;
}

const COMPOSE: Record<ArtPattern, (rand: () => number) => Array<ArtDot>> = {
  halftone,
  orbit,
  strata,
  bloom,
};

/** The art for one identity, from its id. Pure and deterministic. */
export function generatedArt(seed: string): GeneratedArtSpec {
  const rand = random(hash(seed));
  const pattern = PATTERNS[Math.floor(rand() * PATTERNS.length)];
  const stops = palette(rand);
  const angle = Math.round(rand() * 360);
  const corner = rand();
  const glow = {
    x: corner < 0.5 ? 4 : 20,
    y: corner < 0.25 || corner >= 0.75 ? 4 : 20,
  };
  return { pattern, angle, stops, glow, dots: COMPOSE[pattern](rand) };
}
