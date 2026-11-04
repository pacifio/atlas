/** A chunk of an answer: prose, or a diagram. */
export type MermaidPart = { kind: "text"; body: string } | { kind: "mermaid"; body: string };

/**
 * Split an answer on mermaid fences.
 *
 * Written to survive a *streaming* answer, where the closing fence has not
 * arrived yet: an unterminated block stays text, so the reader sees the raw
 * source appear and then resolve into a diagram rather than watching mermaid
 * fail to parse a half-written graph on every token.
 */
export function splitMermaid(content: string): MermaidPart[] {
  const fence = /```mermaid\s*\n([\s\S]*?)```/g;
  const parts: MermaidPart[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push({ kind: "text", body: content.slice(cursor, match.index) });
    }
    parts.push({ kind: "mermaid", body: match[1].trim() });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    parts.push({ kind: "text", body: content.slice(cursor) });
  }
  return parts.filter((p) => p.body.trim().length > 0);
}
