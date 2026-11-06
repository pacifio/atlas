// Pull-request bodies as GitHub writes them: `#12` and bare commit SHAs
// become links into the repository, and an attachment on a line of its own
// (a video, or a bare image URL) is lifted out of the markdown so it can be
// shown as media rather than as a link.

import { findAndReplaceText, type MarkdownNode, type TextMatch } from "./mdast-find-and-replace";

const AUTOLINK_CANDIDATE_PATTERN = /#[1-9]\d*|[0-9a-f]{40}/giu;
const AUTOLINK_WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const AUTOLINK_COMMIT_PREFIX_PATTERN = /[\s([{]/u;
const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference", "inlineCode", "code"]);

/** A remark plugin: `#12` → `<repo>/issues/12` (GitHub redirects a pull
 *  request's number there), a 40-character SHA → `<repo>/commit/<sha>` shown
 *  as its first seven. Not inside links or code, and not in the middle of a
 *  word. */
export function remarkPullRequestAutolinks(options: { repositoryUrl: string }) {
  const repositoryUrl = options.repositoryUrl.replace(/\/+$/u, "");
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      AUTOLINK_CANDIDATE_PATTERN,
      (matched: string, match: TextMatch) => {
        const reference = matched.startsWith("#");
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (
          (before !== undefined &&
            (reference
              ? AUTOLINK_WORD_CHARACTER_PATTERN.test(before)
              : !AUTOLINK_COMMIT_PREFIX_PATTERN.test(before))) ||
          (after !== undefined && AUTOLINK_WORD_CHARACTER_PATTERN.test(after))
        ) {
          return false;
        }
        return {
          type: "link",
          url: reference
            ? `${repositoryUrl}/issues/${matched.slice(1)}`
            : `${repositoryUrl}/commit/${matched}`,
          data: {
            hProperties: { dataPullRequestAutolink: reference ? "reference" : "commit" },
          },
          children: [{ type: "text", value: reference ? matched : matched.slice(0, 7) }],
        };
      },
      AUTOLINK_IGNORED_TYPES,
    );
  };
}

/** `https://github.com/owner/name` from a pull request's own URL. */
export function repositoryUrlOf(pullRequestUrl: string): string | null {
  const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/u.exec(pullRequestUrl);
  return match?.[1] ?? null;
}

/** `id` is positional on purpose: one attachment can be embedded twice. */
export type PullRequestBodySegment =
  | { id: string; kind: "markdown"; text: string }
  | { id: string; kind: "attachment"; url: string; media: "video" | "image" };

const FENCE_PATTERN = /^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)$/u;
/** How far a `<video>` tag may reach for its closing tag. */
const VIDEO_TAG_MAX_LINES = 8;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|svg)(?:$|[?#])/iu;
const MARKDOWN_LINK_PATTERN = /^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/u;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu;
/** A bare user-attachments link is how GitHub embeds a dragged-in video. */
const GITHUB_ASSET_PATTERN = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/iu;
const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu;
const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu;
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu;

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function attachmentFromLine(line: string): { url: string; media: "video" | "image" } | null {
  const url =
    BARE_URL_PATTERN.exec(line.trim())?.[1] ?? MARKDOWN_LINK_PATTERN.exec(line.trim())?.[1];
  if (url === undefined || !isWebUrl(url)) return null;
  if (VIDEO_EXTENSION_PATTERN.test(url) || GITHUB_ASSET_PATTERN.test(url)) {
    return { url, media: "video" };
  }
  if (IMAGE_EXTENSION_PATTERN.test(url)) return { url, media: "image" };
  return null;
}

/** Split a body into markdown runs and the attachments between them. Code
 *  (fenced or indented) is never split. */
export function splitPullRequestBody(body: string): PullRequestBodySegment[] {
  const segments: PullRequestBodySegment[] = [];
  const markdown: string[] = [];
  let openFence: string | null = null;

  // Blank lines around a run are dropped, never leading spaces: four of them
  // open an indented code block.
  const flushMarkdown = () => {
    const text = markdown.join("\n").replace(/^\n+/u, "").replace(/\s+$/u, "");
    markdown.length = 0;
    if (text.trim().length > 0) {
      segments.push({ id: `markdown:${segments.length}`, kind: "markdown", text });
    }
  };

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch !== null) {
      const fence = fenceMatch[1];
      const closes =
        openFence !== null &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        fenceMatch[2].trim().length === 0;
      if (openFence === null) openFence = fence;
      else if (closes) openFence = null;
      markdown.push(line);
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }

    const bare = attachmentFromLine(line);
    if (bare !== null) {
      flushMarkdown();
      segments.push({ id: `attachment:${segments.length}`, kind: "attachment", ...bare });
      continue;
    }

    if (!STANDALONE_VIDEO_TAG_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }
    const lastCandidate = Math.min(index + VIDEO_TAG_MAX_LINES, lines.length) - 1;
    let cursor = index;
    while (cursor < lastCandidate && !VIDEO_TAG_END_PATTERN.test(lines[cursor])) cursor += 1;
    const source = VIDEO_TAG_END_PATTERN.test(lines[cursor])
      ? VIDEO_TAG_SRC_PATTERN.exec(lines.slice(index, cursor + 1).join("\n"))?.[1]
      : undefined;
    if (source !== undefined && isWebUrl(source)) {
      flushMarkdown();
      segments.push({
        id: `attachment:${segments.length}`,
        kind: "attachment",
        url: source,
        media: "video",
      });
      index = cursor;
    } else {
      markdown.push(line);
    }
  }

  flushMarkdown();
  return segments;
}
