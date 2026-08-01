// Pure markdown → sanitized-HTML pipeline. Lives in its own module so it can
// be imported BOTH on the main thread (synchronous fast path for small blocks
// + worker-unavailable fallback) and inside the markdown Web Worker
// (`markdown.worker.ts`) without the logic drifting between the two.
//
// Pipeline (mirrors react-markdown internals):
//   remark-parse → remark-gfm → remark-rehype
//   → rehype-highlight (tokenise code blocks) → rehype-sanitize
//   → rehype-stringify.
//
// `rehype-sanitize` is in the chain on purpose: the HTML lands in the DOM via
// `dangerouslySetInnerHTML`, so we guarantee no script tags, inline event
// handlers, or `javascript:` URLs survive a malicious or pasted prompt. We
// extend the default schema with the few classNames rehype-highlight emits so
// its colors don't get stripped.

import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  // Allow the inline SVG kind-glyph inside mention chips.
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "svg",
    "path",
    "rect",
    "line",
    "circle",
  ],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
    pre: [...(defaultSchema.attributes?.pre ?? []), ["className"]],
    // `span` also carries our mention-chip pills (class + kind + title).
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className"],
      "dataMentionKind",
      "title",
    ],
    svg: [
      "className",
      "viewBox",
      "width",
      "height",
      "fill",
      "stroke",
      "strokeWidth",
      "strokeLinecap",
      "strokeLinejoin",
      "ariaHidden",
    ],
    path: ["d"],
    rect: ["x", "y", "width", "height", "rx", "ry"],
    line: ["x1", "x2", "y1", "y2"],
    circle: ["cx", "cy", "r"],
  },
};

// ── Mention chips ─────────────────────────────────────────────────────────────
// The composer serializes mentions to short forms (`#skill:foo`, `@file:src/x.ts`
// — see `mentions.ts` `toShortForm`). In the sent transcript those would show as
// raw text, so this rehype pass turns them into the same `.atlas-mention-chip`
// pills the composer uses. Kind is derived from the prefix; tokens inside
// `code`/`pre` are left literal. Dependency-free hast walk (also runs in the
// markdown worker).

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};

const MENTION_PREFIX_KIND: Record<string, string> = {
  "@file": "file",
  "@folder": "folder",
  "@symbol": "symbol",
  "@note": "knowledge",
  "@repo": "repo",
  "@paper": "paper",
  "@branch": "branch",
  "@msg": "past_message",
  "@session": "past_session",
  "#skill": "skill",
  "#command": "command",
  "#agent": "agent",
  "#rule": "rule",
};

// Not anchored inside words (avoids emails like `a@file:x`). Value runs to the
// next whitespace; trailing punctuation is peeled back off into plain text.
const MENTION_TOKEN_RE =
  /(?<![\w/])([@#](?:file|folder|symbol|note|repo|paper|branch|msg|session|skill|command|agent|rule)):(\S+)/g;

function baseName(s: string): string {
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// Lucide icon node data (v0.468.0) per mention kind — identical to the glyphs
// the `#`/`@` picker renders, so a sent message matches what you typed.
const MENTION_GLYPH: Record<
  string,
  [string, Record<string, string | number>][]
> = {
  skill: [
    [
      "path",
      {
        d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
      },
    ],
  ],
  command: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["line", { x1: "9", x2: "15", y1: "15", y2: "9" }],
  ],
  agent: [
    ["path", { d: "M12 8V4H8" }],
    ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }],
  ],
  rule: [
    ["path", { d: "m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" }],
    ["path", { d: "m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" }],
    ["path", { d: "M7 21h10" }],
    ["path", { d: "M12 3v18" }],
    ["path", { d: "M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" }],
  ],
  file: [
    [
      "path",
      { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" },
    ],
    ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
    ["path", { d: "M10 9H8" }],
    ["path", { d: "M16 13H8" }],
    ["path", { d: "M16 17H8" }],
  ],
  folder: [
    [
      "path",
      {
        d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      },
    ],
  ],
  symbol: [
    ["line", { x1: "4", x2: "20", y1: "9", y2: "9" }],
    ["line", { x1: "4", x2: "20", y1: "15", y2: "15" }],
    ["line", { x1: "10", x2: "8", y1: "3", y2: "21" }],
    ["line", { x1: "16", x2: "14", y1: "3", y2: "21" }],
  ],
  knowledge: [
    ["path", { d: "M12 7v14" }],
    [
      "path",
      {
        d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
      },
    ],
  ],
  repo: [
    [
      "path",
      {
        d: "M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5",
      },
    ],
    ["circle", { cx: "13", cy: "12", r: "2" }],
    ["path", { d: "M18 19c-2.8 0-5-2.2-5-5v8" }],
    ["circle", { cx: "20", cy: "19", r: "2" }],
  ],
  paper: [
    [
      "path",
      {
        d: "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2",
      },
    ],
    ["path", { d: "M18 14h-8" }],
    ["path", { d: "M15 18h-5" }],
    ["path", { d: "M10 6h8v4h-8V6Z" }],
  ],
  branch: [
    ["line", { x1: "6", x2: "6", y1: "3", y2: "15" }],
    ["circle", { cx: "18", cy: "6", r: "3" }],
    ["circle", { cx: "6", cy: "18", r: "3" }],
    ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
  ],
  past_message: [
    [
      "path",
      { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
    ],
  ],
  past_session: [
    [
      "path",
      { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
    ],
  ],
};

/** Build the kind glyph as a hast `<span class=icon><svg>…</svg></span>`. */
function iconWrap(kind: string): Hast | null {
  const nodes = MENTION_GLYPH[kind];
  if (!nodes) return null;
  return {
    type: "element",
    tagName: "span",
    properties: { className: ["atlas-mention-chip__icon"] },
    children: [
      {
        type: "element",
        tagName: "svg",
        properties: {
          viewBox: "0 0 24 24",
          width: 11,
          height: 11,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          ariaHidden: "true",
        },
        children: nodes.map(([tag, attrs]) => ({
          type: "element",
          tagName: tag,
          properties: { ...attrs },
          children: [],
        })),
      },
    ],
  };
}

function chipNode(prefix: string, value: string): Hast {
  const kind = MENTION_PREFIX_KIND[prefix] ?? "file";
  const isPath = kind === "file" || kind === "folder";
  const label = isPath ? baseName(value) : value;
  const icon = iconWrap(kind);
  const children: Hast[] = [];
  if (icon) children.push(icon);
  children.push({
    type: "element",
    tagName: "span",
    properties: { className: ["atlas-mention-chip__label"] },
    children: [{ type: "text", value: label }],
  });
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["atlas-mention-chip", "atlas-mention-chip--msg"],
      dataMentionKind: kind,
      title: `${prefix}:${value}`,
    },
    children,
  };
}

/** Split one text value into [text, chip, text, …]; null when no token matched. */
function splitMentionText(value: string): Hast[] | null {
  MENTION_TOKEN_RE.lastIndex = 0;
  const out: Hast[] = [];
  let last = 0;
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = MENTION_TOKEN_RE.exec(value)) !== null) {
    found = true;
    if (m.index > last)
      out.push({ type: "text", value: value.slice(last, m.index) });
    let val = m[2];
    let trailing = "";
    const tm = val.match(/[.,;:!?)\]]+$/);
    if (tm) {
      trailing = tm[0];
      val = val.slice(0, -trailing.length);
    }
    out.push(chipNode(m[1], val));
    if (trailing) out.push({ type: "text", value: trailing });
    last = m.index + m[0].length;
  }
  if (!found) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

const MENTION_SKIP_TAGS = new Set(["code", "pre"]);

function rehypeMentionChips() {
  return (tree: Hast) => {
    const walk = (node: Hast) => {
      if (!node.children) return;
      const next: Hast[] = [];
      for (const child of node.children) {
        if (
          child.type === "element" &&
          child.tagName &&
          MENTION_SKIP_TAGS.has(child.tagName)
        ) {
          next.push(child); // leave tokens inside code literal
          continue;
        }
        if (child.type === "text" && typeof child.value === "string") {
          const split = splitMentionText(child.value);
          if (split) {
            next.push(...split);
            continue;
          }
          next.push(child);
          continue;
        }
        if (child.type === "element") walk(child);
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}

let processor: Processor | null = null;
function getProcessor(): Processor {
  if (!processor) {
    processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: false })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeMentionChips as any)
      // `detect: false`: only highlight fenced blocks with an explicit language
      // tag. Auto-detection ran highlight.js across ~37 languages for EVERY
      // un-tagged code block — the dominant per-parse cost. Agents almost always
      // tag their fences, so this is a large, near-invisible win.
      .use(rehypeHighlight, { detect: false, plainText: ["text", "plaintext"] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeSanitize, SANITIZE_SCHEMA as any)
      .use(rehypeStringify) as unknown as Processor;
  }
  return processor;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Parse one markdown source string to sanitized HTML. Synchronous and
 *  uncached — callers own caching. Never throws: falls back to an escaped
 *  paragraph on parser error. */
export function parseMarkdown(src: string): string {
  try {
    return String(getProcessor().processSync(src));
  } catch {
    return `<p>${escapeHtml(src)}</p>`;
  }
}
