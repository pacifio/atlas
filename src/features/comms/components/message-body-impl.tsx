// Implementation half of `./message-body`. Reached ONLY through the `lazy()`
// boundary there — a static import of this module puts the ~554 KB
// `vendor-markdown` chunk (react-markdown + remark + rehype-highlight) into
// whatever chunk imports it, which is the regression `src/lib/markdown.tsx`
// exists to prevent.
//
// Why comms has its own component map instead of using the shared `<Markdown>`
// in `src/lib/markdown.tsx`: comms would have to supply the whole map anyway —
// a 12.5px chat scale, a mention token type that exists nowhere else, tables
// that must scroll inside a ~390px panel, and images demoted to links. What
// would actually be shared is `lazy()` + `<Suspense>` + a CSS import, about
// fifteen lines, and widening `MarkdownProps` would charge the three existing
// callers for a props surface they never use. (`markdown-impl`,
// `markdown-fileviewer` and `readme-view` ARE near-copies of each other and
// deserve converging — that is a separate refactor with its own regression
// surface, and comms is not one of them.)
//
// No `rehype-raw` and no `rehype-sanitize`, deliberately. react-markdown
// rewrites raw HTML nodes to text on its own, so a `<script>` in a message
// renders as the visible characters a colleague typed. That satisfies
// `docs/chat/00-api-map.md:385` ("strict sanitizer; never raw HTML") by making
// an HTML string impossible rather than by filtering one — which matters more
// here than in the agent chat, because these bodies are written by other
// people.

import { useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Image as ImageIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { remarkCommsInline } from "../lib/remark-comms-inline";
import { MENTION_AVATAR_SIZE, mentionPillClass } from "../lib/mention-pill";
import { CommsAvatar } from "./comms-avatar";
import { MentionContext } from "./message-body-context";

/* Module-level constants, all three of them. A fresh array or object literal in
   JSX rebuilds the unified processor and defeats react-markdown's own
   memoisation on every render — and `MessageRow` re-renders on every reaction,
   read receipt and hover. */
const REMARK_PLUGINS = [remarkGfm, remarkCommsInline];
// `detect: false`: guessing a language from a three-line snippet is usually
// wrong, and wrong colouring reads as corruption. Only a tagged fence gets
// highlighted, matching the agent pipeline (`markdown-render.ts`).
const REHYPE_PLUGINS: [typeof rehypeHighlight, { detect: false; ignoreMissing: true }][] = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
];

/**
 * The only schemes a message may link to.
 *
 * react-markdown's default already blocks `javascript:`, but it permits
 * `ircs:`/`xmpp:` and — the one that matters in a desktop webview — RELATIVE
 * urls, which on click would navigate the whole Atlas frame away from the app.
 * A rejected url becomes `""`, and the click handler refuses to open it.
 */
function commsUrlTransform(url: string): string {
  try {
    // The sentinel base turns a relative url into a scheme we do not allow,
    // rather than into whatever the current document happens to be.
    const parsed = new URL(url, "atlas-invalid:");
    return /^(https?|mailto):$/i.test(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}

function isOpenable(href: string | undefined): href is string {
  return !!href && commsUrlTransform(href) !== "";
}

/** Read a `data-*` prop. React's HTML types carry no index signature for them. */
function dataProp(props: unknown, name: string): string | undefined {
  const value = (props as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function Mention({ userId, broadcast }: { userId?: string; broadcast?: string }) {
  const { members, me } = useContext(MentionContext);
  const member = userId ? (members.get(userId) ?? null) : null;
  // A broadcast notifies everyone, so it always reads as addressed to you.
  const highlight = broadcast !== undefined || userId === me;
  return (
    <span
      title={member?.email}
      data-mention-pill=""
      data-mention-self={highlight ? "" : undefined}
      className={mentionPillClass(highlight)}
    >
      {/* No face for `@channel`/`@here` — there is nobody in particular to
          show. A mention whose id the roster cannot resolve still gets an
          avatar, because the fallback initial is derived from the id and is
          more identifying than the word "unknown". */}
      {broadcast === undefined && <CommsAvatar member={member} size={MENTION_AVATAR_SIZE} />}
      <span>{broadcast !== undefined ? `@${broadcast}` : `@${member?.name ?? "unknown"}`}</span>
    </span>
  );
}

function ExternalLink({
  href,
  children,
  className,
}: {
  href?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      // The href stays on the anchor for hover preview and copy-link, but the
      // navigation is ours: a webview must hand a url to the system browser,
      // not load it in place. Same contract as `call-menu.tsx`.
      onClick={(e) => {
        e.preventDefault();
        if (isOpenable(href)) void openUrl(href).catch(() => {});
      }}
      className={cn("underline underline-offset-2 text-text-primary", className)}
    >
      {children}
    </a>
  );
}

/** The `language-x` class rehype-highlight leaves on the `code` inside a `pre`. */
function fenceLanguage(node: unknown): string | null {
  const code = (node as { children?: { properties?: { className?: unknown } }[] })?.children?.[0];
  const classes = code?.properties?.className;
  if (!Array.isArray(classes)) return null;
  for (const c of classes) {
    if (typeof c === "string" && c.startsWith("language-")) return c.slice(9);
  }
  return null;
}

const COMPONENTS: Components = {
  // Every mention arrives as a span carrying a data attribute (see
  // `remark-comms-inline`). Bare spans are not something remark/GFM emits, but
  // the fall-through keeps a future plugin's span from being eaten.
  span(props) {
    const userId = dataProp(props, "data-mention");
    const broadcast = dataProp(props, "data-broadcast");
    if (userId !== undefined) return <Mention userId={userId} />;
    if (broadcast !== undefined) return <Mention broadcast={broadcast} />;
    const { node: _node, ...rest } = props;
    return <span {...rest} />;
  },

  // No `whitespace-pre-wrap`: the newlines are `break` nodes now, and keeping
  // both would double every line gap.
  p: (props) => <p className="my-0">{props.children}</p>,

  code(props) {
    const { node: _node, className, children, ...rest } = props;
    if (!className) {
      return (
        <code
          className="rounded px-1 py-px font-mono text-[11px] bg-white/[0.07] text-text-primary"
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },

  pre(props) {
    const lang = fenceLanguage(props.node);
    return (
      <pre
        className={cn(
          "my-1.5 overflow-x-auto rounded-md px-2.5 py-2 font-mono text-[11px] leading-[1.55] hide-scrollbar",
          "bg-black/50 border border-border-subtle",
        )}
      >
        {lang && (
          <span className="mb-1 block text-[9px] uppercase tracking-wide opacity-45">{lang}</span>
        )}
        {props.children}
      </pre>
    );
  },

  a: (props) => <ExternalLink href={props.href}>{props.children}</ExternalLink>,

  // An image is rendered as a LINK, never an `<img>`. Two reasons, and the
  // second is the real one: the app CSP (`tauri.conf.json`) blocks remote
  // origins, so an `<img>` would paint a broken glyph — and honouring one would
  // let any member drop a tracking pixel that reports the reader's IP address
  // and the moment they opened the conversation.
  img(props) {
    const alt = typeof props.alt === "string" && props.alt ? props.alt : "image";
    return (
      <ExternalLink href={typeof props.src === "string" ? props.src : undefined}>
        <ImageIcon size={10} className="mr-0.5 inline align-[-1px]" />
        {alt}
      </ExternalLink>
    );
  },

  // `[&_ul]` keeps a nested list — newly possible — from stacking margins or
  // marching off the right edge of a narrow panel.
  ul: (props) => (
    <ul className="my-1 space-y-0.5 pl-4 list-disc marker:text-text-tertiary [&_ul]:my-0.5 [&_ol]:my-0.5 [&_ul]:pl-3.5 [&_ol]:pl-3.5">
      {props.children}
    </ul>
  ),
  ol: (props) => (
    <ol
      start={props.start}
      className="my-1 space-y-0.5 pl-4 list-decimal marker:text-text-tertiary [&_ul]:my-0.5 [&_ol]:my-0.5 [&_ul]:pl-3.5 [&_ol]:pl-3.5"
    >
      {props.children}
    </ol>
  ),
  li(props) {
    const classes = (props.node as { properties?: { className?: unknown } })?.properties?.className;
    const isTask = Array.isArray(classes) && classes.includes("task-list-item");
    return <li className={isTask ? "list-none -ml-3" : "pl-0.5"}>{props.children}</li>;
  },
  // Kept disabled: a message is immutable, so a checkbox you could tick would
  // be lying about what it does.
  input: (props) =>
    props.type === "checkbox" ? (
      <input
        type="checkbox"
        checked={!!props.checked}
        disabled
        readOnly
        className="mr-1.5 align-[-1px] accent-[var(--accent-primary)] pointer-events-none"
      />
    ) : null,

  blockquote: (props) => (
    <blockquote className="my-1 border-l-2 pl-2 opacity-80 border-border-strong">
      {props.children}
    </blockquote>
  ),

  // A chat bubble is not a document: headings step down in weight and spacing,
  // not up to document sizes. h4-h6 stop growing and go quiet instead.
  h1: (props) => (
    <h1 className="mt-2 mb-1 text-[14px] font-semibold text-text-primary">{props.children}</h1>
  ),
  h2: (props) => (
    <h2 className="mt-2 mb-1 text-[13px] font-semibold text-text-primary">{props.children}</h2>
  ),
  h3: (props) => (
    <h3 className="mt-1.5 mb-0.5 text-[12.5px] font-semibold text-text-primary">
      {props.children}
    </h3>
  ),
  h4: (props) => (
    <h4 className="mt-1.5 mb-0.5 text-[12.5px] font-semibold text-text-secondary">
      {props.children}
    </h4>
  ),
  h5: (props) => (
    <h5 className="mt-1.5 mb-0.5 text-[12.5px] font-semibold text-text-secondary">
      {props.children}
    </h5>
  ),
  h6: (props) => (
    <h6 className="mt-1.5 mb-0.5 text-[12.5px] font-semibold text-text-secondary">
      {props.children}
    </h6>
  ),

  hr: () => <hr className="my-2 border-0 border-t border-border-subtle" />,

  // `w-max min-w-full` plus `whitespace-nowrap` cells is what makes a wide
  // table SCROLL in a ~390px panel. `w-full` would instead crush every column
  // to a word per line, which is how a table stops being a table.
  table: (props) => (
    <div className="my-1.5 overflow-x-auto hide-scrollbar rounded-md border border-border-subtle">
      <table className="w-max min-w-full border-collapse text-[11px]">{props.children}</table>
    </div>
  ),
  thead: (props) => <thead className="bg-white/[0.04]">{props.children}</thead>,
  th: (props) => (
    <th className="whitespace-nowrap border-b border-border-subtle px-2 py-1 text-left text-[10px] font-semibold text-text-secondary">
      {props.children}
    </th>
  ),
  tr: (props) => (
    <tr className="border-b border-border-subtle last:border-b-0">{props.children}</tr>
  ),
  td: (props) => (
    <td className="whitespace-nowrap px-2 py-1 align-top text-text-primary">{props.children}</td>
  ),

  strong: (props) => <strong className="font-semibold">{props.children}</strong>,
  em: (props) => <em className="italic">{props.children}</em>,
  del: (props) => <span className="line-through opacity-70">{props.children}</span>,
};

export default function MessageBodyImpl({ body }: { body: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={commsUrlTransform}
      components={COMPONENTS}
    >
      {body}
    </ReactMarkdown>
  );
}
