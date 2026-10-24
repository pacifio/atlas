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
import { baseNameOf, isAbsolutePath, resolveInProject } from "./file-links";
import { applyFileChips, fileChipNode, plainText, type Hast } from "./file-chip-hast";
import { leadingLinkTextLength, linkFacts, textIsAddress } from "./link-services";

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  // Allow the inline SVG kind-glyph inside mention chips.
  tagNames: [...(defaultSchema.tagNames ?? []), "svg", "path", "rect", "line", "circle"],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
    // A web link's service, for its icon, and the address a copy carries
    // when its text was shortened (`rehypeLinkIcons`).
    // The first definition of a property wins, so the default's own
    // `className` (footnotes only) is replaced, not added to.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter(
        (d) => !(Array.isArray(d) && d[0] === "className"),
      ),
      ["className", "data-footnote-backref", "atlas-link", "atlas-link--mono"],
      "title",
      "dataLinkService",
      "dataLinkCopy",
    ],
    pre: [...(defaultSchema.attributes?.pre ?? []), ["className"]],
    // `span` also carries our mention-chip pills (class + kind + title), and a
    // file chip's target and icon slot (`fileChipNode`).
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className"],
      "dataMentionKind",
      "title",
      "dataFilePath",
      "dataFileLine",
      "dataFileColumn",
      "dataFileIcon",
      "dataFileRoot",
      "dataFileTrusted",
      "dataLinkService",
      "ariaHidden",
      "role",
      "tabIndex",
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

const MENTION_PREFIX_KIND: Record<string, string> = {
  "@file": "file",
  "@folder": "folder",
  "@symbol": "symbol",
  "@note": "knowledge",
  "@repo": "repo",
  "@branch": "branch",
  "@msg": "past_message",
  "@session": "past_session",
  "@member": "member",
  "@conversation": "conversation",
  "@recorded-session": "recorded_session",
  "@comment": "comment",
  // A large paste and a cited passage write their ids (`@paste:k3x9q2`),
  // which mean nothing to a reader: they draw as a fixed label instead.
  "@paste": "pasted_text",
  "@cite": "cited_text",
  "@review": "review_comment",
  "#skill": "skill",
  "#command": "command",
  "#agent": "agent",
  "#rule": "rule",
};

// Not anchored inside words (avoids emails like `a@file:x`). A value with
// whitespace in it is serialized quoted (`@file:"My Shot.png"`, see
// `mentions.ts` `toShortForm`) and runs to the closing quote; a bare value runs
// to the next whitespace, and its trailing punctuation is peeled back off into
// plain text.
const MENTION_TOKEN_RE =
  /(?<![\w/])([@#](?:file|folder|symbol|note|repo|branch|msg|session|member|conversation|recorded-session|comment|paste|cite|review|skill|command|agent|rule)):(?:"([^"\n]+)"|(?!")(\S+))/g;

// Tokens are lifted out of the source BEFORE remark parses it, and parked
// behind private-use placeholders. Left in, GFM gets to them first: a Retina
// screenshot's `Shot@2x.png` is an email autolink literal, `*` in a name is
// emphasis, and either splits the token across nodes before any hast pass
// could see it whole.
const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";
const PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;

interface MentionToken {
  prefix: string;
  value: string;
  /** The source text, restored verbatim where no chip is drawn (code). */
  raw: string;
}

function protectMentions(src: string): { text: string; tokens: MentionToken[] } {
  const tokens: MentionToken[] = [];
  MENTION_TOKEN_RE.lastIndex = 0;
  const text = src.replace(
    MENTION_TOKEN_RE,
    (match, prefix: string, quoted: string | undefined, bare: string | undefined) => {
      let value = quoted ?? bare ?? "";
      let raw = match;
      let trailing = "";
      if (quoted === undefined) {
        const tm = value.match(/[.,;:!?)\]]+$/);
        if (tm) {
          trailing = tm[0];
          value = value.slice(0, -trailing.length);
          raw = match.slice(0, -trailing.length);
        }
      }
      if (!value) return match;
      tokens.push({ prefix, value, raw });
      return `${PH_OPEN}${tokens.length - 1}${PH_CLOSE}${trailing}`;
    },
  );
  return { text, tokens };
}

// Lucide icon node data (v0.468.0) per mention kind — identical to the glyphs
// the `#`/`@` picker renders, so a sent message matches what you typed.
const MENTION_GLYPH: Record<string, [string, Record<string, string | number>][]> = {
  pasted_text: [
    ["path", { d: "M11 14h10" }],
    ["path", { d: "M16 4h2a2 2 0 0 1 2 2v1.344" }],
    ["path", { d: "m17 18 4-4-4-4" }],
    ["path", { d: "M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113" }],
    ["rect", { x: "8", y: "2", width: "8", height: "4", rx: "1" }],
  ],
  cited_text: [
    [
      "path",
      {
        d: "M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
      },
    ],
    [
      "path",
      {
        d: "M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
      },
    ],
  ],
  review_comment: [
    [
      "path",
      {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    ],
    ["path", { d: "m10 8-3 3 3 3" }],
    ["path", { d: "m14 14 3-3-3-3" }],
  ],
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
    ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }],
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
  branch: [
    ["line", { x1: "6", x2: "6", y1: "3", y2: "15" }],
    ["circle", { cx: "18", cy: "6", r: "3" }],
    ["circle", { cx: "6", cy: "18", r: "3" }],
    ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
  ],
  past_message: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  past_session: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  member: [
    ["path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" }],
    ["circle", { cx: "12", cy: "7", r: "4" }],
  ],
  conversation: [
    [
      "path",
      {
        d: "M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
      },
    ],
    [
      "path",
      {
        d: "M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1",
      },
    ],
  ],
  recorded_session: [
    [
      "path",
      {
        d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
      },
    ],
    ["path", { d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" }],
    ["path", { d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" }],
  ],
  comment: [
    ["path", { d: "M14 14a2 2 0 0 0 2-2V8h-2" }],
    [
      "path",
      {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    ],
    ["path", { d: "M8 14a2 2 0 0 0 2-2V8H8" }],
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

/** Kinds whose token value is an opaque id: the chip says what it is. */
const FIXED_LABEL: Record<string, string> = {
  pasted_text: "Pasted text",
  cited_text: "Cited passage",
  review_comment: "Review comment",
};

function chipNode(prefix: string, value: string, data: RenderData): Hast {
  const kind = MENTION_PREFIX_KIND[prefix] ?? "file";
  if (kind === "file" || kind === "folder") {
    // A mention's path is project-relative (`toShortForm`), or absolute when
    // the file is outside the project. Outside it, only a path the composer
    // attached to this very message opens (`trustedPaths`): the user picked
    // that file themselves. Any other text can write any `@file:` it likes —
    // an agent's reply, replayed history, a handoff prompt quoting a pull
    // request's check names — so there it opens project files only, as inline
    // code does: never `@file:/Applications/Some.app`.
    const resolved = data.fileRoot ? resolveInProject(value, data.fileRoot) : null;
    const outside =
      !resolved && isAbsolutePath(value) && data.trustedPaths?.has(value) ? value : null;
    const absolute = resolved ?? outside;
    return fileChipNode({
      target: absolute ? { path: absolute, folder: kind === "folder" } : null,
      iconPath: absolute ?? value,
      folder: kind === "folder",
      label: baseNameOf(value),
      title: absolute ?? value,
      root: resolved ? data.fileRoot : undefined,
      trusted: outside !== null,
    });
  }
  const label = FIXED_LABEL[kind] ?? value;
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

/** Split one text value into [text, chip, text, …]; null when it holds no
 *  placeholder. Inside code the token goes back in as literal text instead. */
function splitMentionText(
  value: string,
  tokens: MentionToken[],
  literal: boolean,
  data: RenderData,
): Hast[] | null {
  PLACEHOLDER_RE.lastIndex = 0;
  const out: Hast[] = [];
  let last = 0;
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(value)) !== null) {
    found = true;
    const token = tokens[Number(m[1])];
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    if (!token) out.push({ type: "text", value: m[0] });
    else if (literal) out.push({ type: "text", value: token.raw });
    else out.push(chipNode(token.prefix, token.value, data));
    last = m.index + m[0].length;
  }
  if (!found) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  if (literal) {
    // Adjacent text nodes merge back into one, so highlighters see the line whole.
    return [{ type: "text", value: out.map((n) => n.value ?? "").join("") }];
  }
  return out;
}

const MENTION_SKIP_TAGS = new Set(["code", "pre"]);

function rehypeMentionChips() {
  return (tree: Hast, file: { data: RenderData }) => {
    const tokens = file.data.mentionTokens;
    if (!tokens || tokens.length === 0) return;
    const walk = (node: Hast, literal: boolean) => {
      if (!node.children) return;
      const next: Hast[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
          const split = splitMentionText(child.value, tokens, literal, file.data);
          next.push(...(split ?? [child]));
          continue;
        }
        if (child.type === "element") {
          // Tokens inside code stay literal.
          walk(child, literal || (!!child.tagName && MENTION_SKIP_TAGS.has(child.tagName)));
        }
        next.push(child);
      }
      node.children = next;
    };
    walk(tree, false);
  };
}

/** What one parse is handed besides the source. */
type RenderData = {
  mentionTokens?: MentionToken[];
  /** The session's project root. Unset, no path becomes a chip. */
  fileRoot?: string;
  /** See {@link ParseOptions.trustedPaths}. */
  trustedPaths?: ReadonlySet<string>;
};

/** How one string is rendered, besides its project root. */
export interface ParseOptions {
  /**
   * The absolute paths the composer itself attached to this message (the
   * `@file:`/`@folder:` mentions it serialised from picked files): a mention
   * of one of them opens even outside the project. Every other absolute path
   * — in an agent's reply, replayed history, or text pasted into a handoff —
   * is drawn but not clickable; only paths inside the project are.
   */
  trustedPaths?: readonly string[];
}

// ── File paths in prose ───────────────────────────────────────────────────────
// Inline code and link destinations that name a file in the session's project
// become the same chips a mention draws (`file-chip-hast.ts`, shared with every
// other markdown renderer). Runs once per rendered string, and the result is
// cached with the HTML. Fenced code is never touched.

function rehypeFileChips() {
  return (tree: Hast, file: { data: RenderData }) => {
    const root = file.data.fileRoot;
    if (!root) return;
    applyFileChips(tree, { root, label: "written", stampRoot: true });
  };
}

// ── Web links ─────────────────────────────────────────────────────────────────
// An http(s) link wears its service's icon before its text, and the full
// address as its tooltip; written bare, a pull request, issue, commit,
// repository or Linear issue reads short ("PR #42", "ATL-978"). Which service
// and which label is `link-services.ts`. The icon is an empty span painted by
// CSS (`.atlas-link__icon`, a mask in the link's own colour), so it follows
// the theme and costs one element per link. One `URL` parse per anchor, so the
// streaming tail can run it on every tick.

/** Whether any text under a node is more than whitespace. */
function hasWords(node: Hast): boolean {
  for (const child of node.children ?? []) {
    if (child.type === "text" && child.value?.trim()) return true;
    if (child.type === "element" && hasWords(child)) return true;
  }
  return false;
}

/** The icon, with the first characters of the link's text kept on its line. */
function linkLead(service: string, lead: Hast[]): Hast {
  return {
    type: "element",
    tagName: "span",
    properties: { className: ["atlas-link__lead"] },
    children: [
      {
        type: "element",
        tagName: "span",
        properties: {
          className: ["atlas-link__icon"],
          dataLinkService: service,
          ariaHidden: "true",
        },
        children: [],
      },
      ...lead,
    ],
  };
}

function decorateLink(anchor: Hast, href: string): void {
  const facts = linkFacts(href);
  if (!facts) return;
  // An image link, or one with no words, gets no icon.
  if (!hasWords(anchor)) return;
  const text = plainText(anchor);
  const props = (anchor.properties ??= {});
  props.title = href;
  props.dataLinkService = facts.service;
  const className = ["atlas-link"];
  let children = anchor.children ?? [];
  if (facts.short && text !== null && textIsAddress(text, href)) {
    children = [{ type: "text", value: facts.short }];
    props.dataLinkCopy = href;
    if (facts.commit) className.push("atlas-link--mono");
  }
  props.className = className;
  const [first, ...rest] = children;
  if (first?.type === "text" && typeof first.value === "string") {
    const n = leadingLinkTextLength(first.value);
    const tail = first.value.slice(n);
    anchor.children = [
      linkLead(facts.service, [{ type: "text", value: first.value.slice(0, n) }]),
      ...(tail ? [{ type: "text", value: tail }] : []),
      ...rest,
    ];
  } else {
    anchor.children = [linkLead(facts.service, first ? [first] : []), ...rest];
  }
}

function rehypeLinkIcons() {
  return (tree: Hast) => {
    const walk = (node: Hast) => {
      for (const child of node.children ?? []) {
        if (child.type !== "element" || child.tagName === "pre") continue;
        const href = child.tagName === "a" ? child.properties?.href : undefined;
        if (typeof href === "string") decorateLink(child, href);
        else walk(child);
      }
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeFileChips as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeLinkIcons as any)
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
 *  paragraph on parser error.
 *
 *  `fileRoot` is the session's project root: given one, file paths in inline
 *  code and links become chips, and mention chips resolve against it. The
 *  output depends on it (and on `options`), so a cache must key on them too. */
export function parseMarkdown(src: string, fileRoot?: string, options?: ParseOptions): string {
  try {
    const { text, tokens } = protectMentions(src);
    const data: RenderData = {
      mentionTokens: tokens,
      fileRoot: fileRoot || undefined,
      trustedPaths: options?.trustedPaths?.length ? new Set(options.trustedPaths) : undefined,
    };
    return String(getProcessor().processSync({ value: text, data }));
  } catch {
    return `<p>${escapeHtml(src)}</p>`;
  }
}
