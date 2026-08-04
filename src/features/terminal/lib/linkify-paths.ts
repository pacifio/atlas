/** Split a line of terminal text into clickable runs so block output can render
 *  URLs (open in the default browser) and file paths (open in Atlas / reveal in
 *  Finder) as clickable spans. Mirrors the xterm link provider's detection. */

import type { CSSProperties } from "react";
import type { AnsiSegment } from "./ansi-to-segments";

// File path: a run with at least one `/`, made of safe path chars, with an
// optional `:line[:col]` suffix. Colons are excluded from the body so URLs
// don't match as paths (guarded again by the `:` look-behind at use site).
const PATH_RE = /[A-Za-z0-9._~@+\-/]*\/[A-Za-z0-9._~@+\-/]*(?::\d+(?::\d+)?)?/g;

// URLs: explicit-scheme (http/https/file), `www.` hosts, and bare local hosts
// that carry a port (so we don't linkify the bare word "localhost"). Trailing
// sentence punctuation is trimmed after the match.
const URL_RE =
  /(?:https?:\/\/|file:\/\/|www\.)[^\s<>"'`()]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})(?:\/[^\s<>"'`()]*)?/gi;

const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

export type LinkKind = "url" | "path" | "text";

export interface PathRun {
  text: string;
  kind: LinkKind;
}

interface Match {
  start: number;
  end: number;
  kind: "url" | "path";
}

/** Turn a bare/scheme-less URL token into something a browser will open. */
export function normalizeUrl(text: string): string {
  const t = text.replace(TRAILING_PUNCT, "");
  if (/^[a-z]+:\/\//i.test(t)) return t; // already has a scheme
  if (/^www\./i.test(t)) return `https://${t}`;
  return `http://${t}`; // bare localhost / 127.0.0.1:port / …
}

export function splitLinks(text: string): PathRun[] {
  const matches: Match[] = [];

  URL_RE.lastIndex = 0;
  let u: RegExpExecArray | null;
  while ((u = URL_RE.exec(text)) !== null) {
    const trimmed = u[0].replace(TRAILING_PUNCT, "");
    if (trimmed.length < 2) continue;
    matches.push({
      start: u.index,
      end: u.index + trimmed.length,
      kind: "url",
    });
  }

  PATH_RE.lastIndex = 0;
  let p: RegExpExecArray | null;
  while ((p = PATH_RE.exec(text)) !== null) {
    const raw = p[0];
    if (raw.length < 2 || text[p.index - 1] === ":") continue; // skip URL tails
    const start = p.index;
    const end = p.index + raw.length;
    // Drop paths that fall inside an already-matched URL.
    if (matches.some((m) => m.kind === "url" && start < m.end && end > m.start))
      continue;
    matches.push({ start, end, kind: "path" });
  }

  if (matches.length === 0) return [{ text, kind: "text" }];
  matches.sort((a, b) => a.start - b.start);

  const out: PathRun[] = [];
  let last = 0;
  for (const m of matches) {
    if (m.start < last) continue; // overlap guard (URLs win, added first)
    if (m.start > last)
      out.push({ text: text.slice(last, m.start), kind: "text" });
    out.push({
      text: text.slice(m.start, m.end),
      kind: m.kind,
    });
    last = m.end;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: "text" });
  return out;
}

// ── Line-level linkification over styled segments ───────────────────────────

export interface LinkedRun {
  text: string;
  kind: LinkKind;
  /** The FULL matched link text (may span several styled segments) — this is
   *  what a click should open, not this run's possibly-partial `text`. */
  target?: string;
  style?: CSSProperties;
}

/** Linkify styled segments LINE by LINE, then split each detected link back
 *  across the styled segments it covers (styling preserved per run, but every
 *  run of a link carries the whole match as `target`).
 *
 *  Detection MUST see whole lines: tools style parts of a URL differently —
 *  Vite prints `http://localhost:` and `8080/` in different SGR runs — so
 *  per-segment detection matched only `http://localhost:`, the trailing-punct
 *  trim ate the `:`, and clicks opened `http://localhost` without the port. */
export function linkifySegments(segments: AnsiSegment[]): LinkedRun[] {
  const out: LinkedRun[] = [];
  let line: AnsiSegment[] = [];

  const flushLine = () => {
    if (line.length === 0) return;
    if (line.length === 1) {
      // Single-style line — no offset mapping needed.
      const s = line[0];
      for (const r of splitLinks(s.text)) {
        out.push({
          text: r.text,
          kind: r.kind,
          target: r.kind === "text" ? undefined : r.text,
          style: s.style,
        });
      }
      line = [];
      return;
    }
    let lineText = "";
    for (const s of line) lineText += s.text;
    const runs = splitLinks(lineText);
    // Runs and segments cover the same text in order — walk them in lockstep,
    // splitting runs at segment borders so each piece keeps its own style.
    let segIdx = 0;
    let segOff = 0;
    for (const r of runs) {
      let consumed = 0;
      while (consumed < r.text.length && segIdx < line.length) {
        const seg = line[segIdx];
        const take = Math.min(
          r.text.length - consumed,
          seg.text.length - segOff,
        );
        out.push({
          text: r.text.slice(consumed, consumed + take),
          kind: r.kind,
          target: r.kind === "text" ? undefined : r.text,
          style: seg.style,
        });
        consumed += take;
        segOff += take;
        if (segOff >= seg.text.length) {
          segIdx++;
          segOff = 0;
        }
      }
    }
    line = [];
  };

  for (const seg of segments) {
    if (seg.text === "\n") {
      flushLine();
      out.push({ text: "\n", kind: "text" });
    } else {
      line.push(seg);
    }
  }
  flushLine();
  return out;
}
