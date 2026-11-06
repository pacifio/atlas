/** A portable excerpt in the existing comment body, so it survives reloads
 * and is readable by older clients without changing the server's anchor API. */
const PREFIX = "Selected passage:\n\n";

export function quoteLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function selectionCommentBody(selection: string, body: string): string {
  // Quoted agent text must not notify people through the server's <@id>
  // mention parser. Decode only the excerpt when drawing it again.
  const escaped = selection.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `${PREFIX}${quoteLines(escaped)}\n\n${body}`;
}

export function splitSelectionComment(text: string): { selection: string; body: string } | null {
  if (!text.startsWith(PREFIX)) return null;
  const end = text.indexOf("\n\n", PREFIX.length);
  if (end < 0) return null;
  const lines = text.slice(PREFIX.length, end).split("\n");
  if (!lines.every((line) => line.startsWith("> "))) return null;
  return {
    selection: lines
      .map((line) => line.slice(2))
      .join("\n")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&"),
    body: text.slice(end + 2),
  };
}
