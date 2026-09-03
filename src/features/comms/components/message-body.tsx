import { Fragment, memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { MENTION_SOURCE } from "../types";
import type { OrgMemberProfile } from "../types";

/**
 * Chat-message renderer.
 *
 * Deliberately NOT the agent chat's markdown pipeline. That one exists to make
 * a streaming token wall format live and caches aggressively per block; a chat
 * message is short, settled the moment it lands, and — crucially — needs
 * mentions to be real interactive chips resolved against the member directory
 * at render time. Feeding `<@u_id>` through a sanitizing markdown pass gives
 * either an escaped literal or a stripped span, so mentions are parsed here as
 * a first-class inline token instead.
 *
 * Supports what people actually type into a work chat: fenced code, inline
 * code, bold, italic, strikethrough, links, bullet/numbered lists, blockquotes,
 * and mentions. Nothing raw-HTML ever reaches the DOM — every branch below
 * emits React elements from parsed text, so there is no sanitizer to get wrong.
 */

interface MessageBodyProps {
  body: string;
  members: Map<string, OrgMemberProfile>;
  /** The current user — a mention of them is styled differently. */
  me: string;
  className?: string;
}

export const MessageBody = memo(function MessageBody({
  body,
  members,
  me,
  className,
}: MessageBodyProps) {
  const blocks = useMemo(() => splitBlocks(body), [body]);

  return (
    <div className={cn("text-[12.5px] leading-[1.5] break-words", className)}>
      {blocks.map((block, i) => {
        if (block.kind === "code") {
          return (
            <pre
              key={i}
              className={cn(
                "my-1.5 overflow-x-auto rounded-md px-2.5 py-2 font-mono text-[11px] leading-[1.55] hide-scrollbar",
                "bg-black/50 border border-border-subtle",
              )}
            >
              {block.lang && (
                <span className="mb-1 block text-[9px] uppercase tracking-wide opacity-45">
                  {block.lang}
                </span>
              )}
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote
              key={i}
              className={cn("my-1 border-l-2 pl-2 opacity-80", "border-border-strong")}
            >
              {block.lines.map((line, j) => (
                <p key={j} className="my-0.5">
                  <Inline text={line} members={members} me={me} />
                </p>
              ))}
            </blockquote>
          );
        }
        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag
              key={i}
              start={block.ordered ? block.start : undefined}
              className={cn(
                "my-1 space-y-0.5 pl-4",
                block.ordered ? "list-decimal" : "list-disc",
                "marker:text-text-tertiary",
              )}
            >
              {block.items.map((item, j) => (
                <li key={j} className="pl-0.5">
                  <Inline text={item} members={members} me={me} />
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p key={i} className="my-0 whitespace-pre-wrap">
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline text={line} members={members} me={me} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Block splitting
// ---------------------------------------------------------------------------

type Block =
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "para"; lines: string[] };

const FENCE = /^```(\w+)?\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function splitBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const flushPara = (buf: string[]) => {
    if (buf.length) blocks.push({ kind: "para", lines: [...buf] });
    buf.length = 0;
  };

  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara(para);
      const lang = fence[1] ?? null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // consume the closing fence (or run off the end — an unclosed fence
      //     still renders as code, which is what the author meant)
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushPara(para);
      const buf: string[] = [quote[1]];
      i++;
      for (let m = QUOTE.exec(lines[i] ?? ""); m; m = QUOTE.exec(lines[i] ?? "")) {
        buf.push(m[1]);
        i++;
      }
      blocks.push({ kind: "quote", lines: buf });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara(para);
      const isOrdered = !!ordered;
      const start = ordered ? Number(ordered[1]) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = ORDERED.exec(lines[i]);
        if (isOrdered && o) items.push(o[2]);
        else if (!isOrdered && b) items.push(b[1]);
        else break;
        i++;
      }
      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }

    if (line.trim() === "") {
      flushPara(para);
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara(para);
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Order matters: code spans win over emphasis so `**` inside backticks stays
// literal, and mentions are matched before autolinks so an id is never eaten.
const INLINE = new RegExp(
  [
    "(`[^`\\n]+`)", // 1 inline code
    `(${MENTION_SOURCE})`, // 2 mention (3 = id)
    "(?<![\\w@])(@(?:channel|here))\\b", // 4 broadcast
    "(\\*\\*[^*\\n]+\\*\\*)", // 5 bold
    "(~~[^~\\n]+~~)", // 6 strike
    "(\\*[^*\\n]+\\*|_[^_\\n]+_)", // 7 italic
    "(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))", // 8 md link
    "(https?://[^\\s<>]+)", // 9 autolink
  ].join("|"),
  "g",
);

function Inline({
  text,
  members,
  me,
}: {
  text: string;
  members: Map<string, OrgMemberProfile>;
  me: string;
}) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;

  const re = new RegExp(INLINE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    last = m.index + m[0].length;

    const [, code, , mentionId, broadcast, bold, strike, italic, link, auto] = m;

    if (code) {
      nodes.push(
        <code
          key={key++}
          className={cn(
            "rounded px-1 py-px font-mono text-[11px]",
            "bg-white/[0.07] text-text-primary",
          )}
        >
          {code.slice(1, -1)}
        </code>,
      );
    } else if (mentionId) {
      const member = members.get(mentionId);
      nodes.push(
        <Mention
          key={key++}
          label={`@${member?.name ?? "unknown"}`}
          title={member?.email}
          highlight={mentionId === me}
        />,
      );
    } else if (broadcast) {
      // @channel / @here notify everyone, so they always highlight.
      nodes.push(<Mention key={key++} label={broadcast} highlight />);
    } else if (bold) {
      nodes.push(
        <strong key={key++} className="font-semibold">
          {bold.slice(2, -2)}
        </strong>,
      );
    } else if (strike) {
      nodes.push(
        <span key={key++} className="line-through opacity-70">
          {strike.slice(2, -2)}
        </span>,
      );
    } else if (italic) {
      nodes.push(
        <em key={key++} className="italic">
          {italic.slice(1, -1)}
        </em>,
      );
    } else if (link) {
      const split = link.indexOf("](");
      nodes.push(
        <ExternalLink key={key++} href={link.slice(split + 2, -1)}>
          {link.slice(1, split)}
        </ExternalLink>,
      );
    } else if (auto) {
      nodes.push(
        <ExternalLink key={key++} href={auto}>
          {auto}
        </ExternalLink>,
      );
    }
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

function Mention({
  label,
  title,
  highlight,
}: {
  label: string;
  title?: string;
  highlight?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "rounded px-1 py-px font-medium",
        highlight
          ? "bg-[var(--comms-mention-bg)] text-[var(--comms-mention-text)]"
          : "bg-[var(--comms-mention-other-bg)] text-[var(--comms-mention-other-text)]",
      )}
    >
      {label}
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn("underline underline-offset-2", "text-text-primary")}
    >
      {children}
    </a>
  );
}
