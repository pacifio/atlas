/**
 * Dev-only performance recorder for the block terminal.
 *
 * Wraps `performance.mark/measure` so the four stages of the output pipeline
 * can be read from the Safari Web Inspector timeline and, more usefully,
 * summarised per command block in the console the moment the block finishes:
 *
 *   term:chunk    onmessage → parser.push done        (per IPC chunk)
 *   term:flush    parser onChange → React commit       (per render flush)
 *   term:emulate  line emulation inside a flush
 *   term:linkify  link detection inside a flush
 *
 * Everything here compiles to no-ops in production (`import.meta.env.DEV`),
 * and in dev it costs two `performance.now()` calls per stage. Bench recipe,
 * run inside the Atlas terminal:
 *
 *   1. yes | head -c 50M > /tmp/big.log; cat /tmp/big.log      throughput
 *   2. seq 1 2000000                                             many short lines
 *   3. ls -R --color=always /usr/lib | head -c 20M               SGR-heavy
 *   4. for i in $(seq 1 300); do printf '\r[%3d%%] building…' $i; sleep 0.005; done; echo
 *   5. cat /tmp/big.log | head -c 5M; vim   /   less /tmp/big.log   /   htop
 *
 * Read `window.__atlasTermPerf` for the running totals of the live block.
 */

type Stage = "chunk" | "flush" | "emulate" | "linkify";

interface StageStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface BlockStats {
  bytes: number;
  stages: Record<Stage, StageStats>;
}

const DEV = import.meta.env.DEV;

function emptyStats(): BlockStats {
  const s = (): StageStats => ({ count: 0, totalMs: 0, maxMs: 0 });
  return { bytes: 0, stages: { chunk: s(), flush: s(), emulate: s(), linkify: s() } };
}

let live: BlockStats = emptyStats();

/** Start timing a stage. Returns the end function; call it exactly once. */
export function perfBegin(stage: Stage): () => void {
  if (!DEV) return noop;
  const t0 = performance.now();
  return () => {
    const ms = performance.now() - t0;
    const st = live.stages[stage];
    st.count++;
    st.totalMs += ms;
    if (ms > st.maxMs) st.maxMs = ms;
    performance.measure(`term:${stage}`, { start: t0, end: t0 + ms });
  };
}

/** Count bytes that arrived for the live block. */
export function perfBytes(n: number): void {
  if (DEV) live.bytes += n;
}

/** The live block finished: print its table and start a fresh record. */
export function perfBlockDone(command: string): void {
  if (!DEV) return;
  const rows = (Object.keys(live.stages) as Stage[]).map((k) => {
    const s = live.stages[k];
    return {
      stage: k,
      count: s.count,
      "total ms": Math.round(s.totalMs * 10) / 10,
      "avg ms": s.count ? Math.round((s.totalMs / s.count) * 100) / 100 : 0,
      "max ms": Math.round(s.maxMs * 100) / 100,
    };
  });
  if (live.bytes > 4096 || live.stages.flush.count > 20) {
    console.groupCollapsed(
      `[term-perf] ${command.slice(0, 60)} — ${(live.bytes / 1024).toFixed(1)} KB`,
    );
    console.table(rows);
    console.groupEnd();
  }
  live = emptyStats();
}

function noop(): void {}

if (DEV && typeof window !== "undefined") {
  Object.defineProperty(window, "__atlasTermPerf", { get: () => live, configurable: true });
}
