import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StreamSmoother } from "./stream-smoother";
import type { AgentDelta } from "@/types/agents";

/** Test fixture: collect everything the smoother hands downstream. */
const makeSink = () => {
  const out: AgentDelta[] = [];
  const sink = (env: AgentDelta) => out.push(env);
  return { out, sink };
};

const text = (delta: string, session = "s1", messageId = "m1"): AgentDelta => ({
  kind: "text_chunk",
  agent_id: "a1",
  session_id: session,
  message_id: messageId,
  delta,
});

const thinking = (delta: string, session = "s1", messageId = "m1"): AgentDelta => ({
  kind: "thinking_chunk",
  agent_id: "a1",
  session_id: session,
  message_id: messageId,
  delta,
});

const toolCall = (session = "s1"): AgentDelta => ({
  kind: "tool_call_upserted",
  agent_id: "a1",
  session_id: session,
  message_id: "m1",
  tool_call: { id: "t1" } as never,
});

const finished = (stopReason = "end_turn", session = "s1"): AgentDelta =>
  ({
    kind: "turn_finished",
    agent_id: "a1",
    session_id: session,
    stop_reason: stopReason,
  }) as AgentDelta;

const failed = (session = "s1"): AgentDelta =>
  ({
    kind: "turn_failed",
    agent_id: "a1",
    session_id: session,
    error: "boom",
  }) as AgentDelta;

/** Concatenated text of every emitted chunk of `kind` for a session. */
const emittedText = (out: AgentDelta[], kind = "text_chunk", session = "s1") =>
  out
    .filter((e) => e.kind === kind && e.session_id === session)
    .map((e) => (e as { delta: string }).delta)
    .join("");

const TICK = 33;
const LAG = 450;

const makeSmoother = (sink: (env: AgentDelta) => void, smooth = () => true) =>
  new StreamSmoother(sink, {
    tickMs: TICK,
    targetLagMs: LAG,
    minCharsPerTick: 2,
    shouldSmooth: smooth,
  });

describe("StreamSmoother", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spreads a burst out over roughly the target lag instead of emitting it at once", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("x".repeat(450)));

    // Nothing is emitted synchronously…
    expect(emittedText(out)).toBe("");

    // …after ~a third of the lag window, roughly a third has typed out.
    vi.advanceTimersByTime(150);
    const after150 = emittedText(out).length;
    expect(after150).toBeGreaterThan(50);
    expect(after150).toBeLessThan(320);

    // The whole burst lands within a generous multiple of the target lag.
    vi.advanceTimersByTime(LAG * 2);
    expect(emittedText(out)).toBe("x".repeat(450));
    s.dispose();
  });

  it("drains by elapsed time, so throttled (rare, long) ticks still keep pace", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("y".repeat(900)));
    // Simulate WebKit-throttled timers: a single 1s gap between ticks must
    // emit ~a full window's worth, not one tick's worth.
    vi.advanceTimersByTime(1000);
    expect(emittedText(out).length).toBeGreaterThan(500);
    s.dispose();
  });

  it("lets an already-smooth stream through with only floor-rate latency", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    // 2 chars every 30 ms ≈ the floor rate: the queue should hover near empty.
    for (let i = 0; i < 20; i++) {
      s.ingest(text("ab"));
      vi.advanceTimersByTime(30);
    }
    vi.advanceTimersByTime(200);
    expect(emittedText(out)).toBe("ab".repeat(20));
    s.dispose();
  });

  it("preserves wire order: a tool delta between two text runs waits for the first to finish", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("first-run-"));
    s.ingest(toolCall());
    s.ingest(text("second"));

    vi.advanceTimersByTime(LAG * 3);
    const kinds = out.map((e) => e.kind);
    const toolAt = kinds.indexOf("tool_call_upserted");
    expect(toolAt).toBeGreaterThan(0);
    const before = out
      .slice(0, toolAt)
      .map((e) => (e as { delta?: string }).delta ?? "")
      .join("");
    expect(before).toBe("first-run-");
    expect(emittedText(out)).toBe("first-run-second");
    s.dispose();
  });

  it("holds turn_finished until the text tail has typed out", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("tail text that is still typing"));
    s.ingest(finished());

    vi.advanceTimersByTime(TICK * 2);
    expect(out.some((e) => e.kind === "turn_finished")).toBe(false);

    vi.advanceTimersByTime(LAG * 3);
    expect(out[out.length - 1]?.kind).toBe("turn_finished");
    expect(emittedText(out)).toBe("tail text that is still typing");
    s.dispose();
  });

  it("flushes instantly on a cancelled turn", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("partial answer the user cancelled"));
    s.ingest(finished("cancelled"));

    // No timer advance: cancel must land synchronously.
    expect(emittedText(out)).toBe("partial answer the user cancelled");
    expect(out[out.length - 1]?.kind).toBe("turn_finished");
    s.dispose();
  });

  it("flushes instantly on turn_failed", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("half an answer"));
    s.ingest(failed());
    expect(emittedText(out)).toBe("half an answer");
    expect(out[out.length - 1]?.kind).toBe("turn_failed");
    s.dispose();
  });

  it("passes everything through synchronously for sessions it should not smooth", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink, () => false);
    s.ingest(text("immediate"));
    s.ingest(toolCall());
    expect(emittedText(out)).toBe("immediate");
    expect(out[1]?.kind).toBe("tool_call_upserted");
    s.dispose();
  });

  it("keeps thinking and text chunks apart and tags emissions with the right message_id", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(thinking("pondering...", "s1", "m1"));
    s.ingest(text("answer", "s1", "m2"));
    vi.advanceTimersByTime(LAG * 3);
    expect(emittedText(out, "thinking_chunk")).toBe("pondering...");
    expect(emittedText(out, "text_chunk")).toBe("answer");
    for (const e of out) {
      if (e.kind === "thinking_chunk") expect(e.message_id).toBe("m1");
      if (e.kind === "text_chunk") expect(e.message_id).toBe("m2");
    }
    // Thinking (ingested first) must fully precede the text run.
    const lastThinking = out.map((e) => e.kind).lastIndexOf("thinking_chunk");
    const firstText = out.map((e) => e.kind).indexOf("text_chunk");
    expect(lastThinking).toBeLessThan(firstText);
    s.dispose();
  });

  it("never splits a surrogate pair", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("👍".repeat(200)));
    vi.advanceTimersByTime(LAG * 3);
    for (const e of out) {
      if (e.kind !== "text_chunk") continue;
      // Every emitted piece must itself be valid (no lone surrogates).
      expect((e as { delta: string }).delta).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    }
    expect(emittedText(out)).toBe("👍".repeat(200));
    s.dispose();
  });

  it("flushAll dumps every queue synchronously", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("aaa", "s1"));
    s.ingest(text("bbb", "s2"));
    s.flushAll();
    expect(emittedText(out, "text_chunk", "s1")).toBe("aaa");
    expect(emittedText(out, "text_chunk", "s2")).toBe("bbb");
    s.dispose();
  });

  it("smooths independent sessions independently", () => {
    const { out, sink } = makeSink();
    const s = makeSmoother(sink);
    s.ingest(text("1".repeat(300), "s1"));
    s.ingest(text("2".repeat(4), "s2"));
    vi.advanceTimersByTime(LAG * 3);
    expect(emittedText(out, "text_chunk", "s1")).toBe("1".repeat(300));
    expect(emittedText(out, "text_chunk", "s2")).toBe("2".repeat(4));
    s.dispose();
  });
});
