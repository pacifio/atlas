export function normalizeUrl(url: string): string {
  const t = url.trim();
  if (t.startsWith("http://") || t.startsWith("https://")) return t;
  return `https://${t}`;
}

/** Omnibox resolution: a URL/host stays a URL; anything else becomes a Google
 *  search. Mirrors a normal browser's address bar. */
export function toNavUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  // A bare host (has a dot, no spaces) or localhost → treat as a URL.
  const looksLikeUrl = /^localhost(:\d+)?(\/.*)?$/i.test(t) || /^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(t);
  if (looksLikeUrl) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}
