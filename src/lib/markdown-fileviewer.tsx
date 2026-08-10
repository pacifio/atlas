import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import "highlight.js/styles/github-dark.css";

function handleWheel(e: React.WheelEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  let parent = el.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    if (style.overflowY === "auto" || style.overflowY === "scroll") break;
    parent = parent.parentElement;
  }
  parent?.scrollBy({ top: e.deltaY });
}

interface Props {
  children: string;
  /**
   * Enables rendering of raw HTML (e.g. <details>, <img align>, etc.).
   * Should only be enabled for trusted/local Markdown documents.
   */
  trusted?: boolean;
  className?: string;
}
export const MarkdownFile = memo(function MarkdownFile({ children, trusted = false }: Props) {
  return (
    <div className="atlas-markdown text-[14px] leading-relaxed text-[var(--text-primary)] break-words select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[...(trusted ? [rehypeRaw] : []), rehypeHighlight]}
        components={{
          h1: (p) => (
            <h1 className="mt-8 mb-3 border-b border-[var(--border-default)] pb-2 text-[26px] font-bold tracking-tight">
              {p.children}
            </h1>
          ),

          h2: (p) => (
            <h2 className="mt-7 mb-3 border-b border-[var(--border-subtle)] pb-1.5 text-[20px] font-semibold tracking-tight">
              {p.children}
            </h2>
          ),

          h3: (p) => <h3 className="mt-6 mb-2 text-[16px] font-semibold">{p.children}</h3>,

          h4: (p) => <h4 className="mt-4 mb-1.5 text-[14px] font-semibold">{p.children}</h4>,

          p: (p) => <p className="my-3">{p.children}</p>,

          a: (p) => (
            <a
              {...p}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent-primary)] underline hover:opacity-80"
            />
          ),

          ul: (p) => <ul className="my-3 list-disc space-y-1 pl-6">{p.children}</ul>,

          ol: (p) => <ol className="my-3 list-decimal space-y-1 pl-6">{p.children}</ol>,

          li: (p) => <li className="leading-relaxed">{p.children}</li>,

          img: (p) => (
            // eslint-disable-next-line jsx-a11y/alt-text
            <img {...p} className="my-1 inline-block h-auto max-w-full rounded align-middle" />
          ),

          code(props) {
            const { className, children, ...rest } = props as {
              className?: string;
              children?: React.ReactNode;
            };

            const isInline = !className;

            if (isInline) {
              return (
                <code
                  className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[12.5px] text-[var(--text-primary)]"
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

          pre: (p) => (
            <pre
              className="my-4 overflow-x-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[12.5px]"
              style={{
                whiteSpace: "pre",
                wordBreak: "normal",
              }}
              onWheel={handleWheel}
            >
              {p.children}
            </pre>
          ),

          blockquote: (p) => (
            <blockquote className="my-3 border-l-2 border-[var(--border-default)] pl-4 text-[var(--text-secondary)]">
              {p.children}
            </blockquote>
          ),

          hr: () => <hr className="my-6 border-[var(--border-subtle)]" />,

          table: (p) => (
            <div
              className="my-4 overflow-x-auto rounded-md border border-[var(--border-default)]"
              onWheel={handleWheel}
            >
              <table className="min-w-max text-[13px] ">{p.children}</table>
            </div>
          ),

          thead: (p) => <thead className="bg-[var(--bg-elevated)]">{p.children}</thead>,

          tr: (p) => (
            <tr className="border-b border-[var(--border-subtle)] last:border-b-0">{p.children}</tr>
          ),

          th: (p) => (
            <th className="border-r border-[var(--border-default)] border-b border-[var(--border-default)] px-3 py-2 text-left text-[12px] font-semibold whitespace-nowrap text-[var(--text-secondary)] last:border-r-0">
              {p.children}
            </th>
          ),

          td: (p) => (
            <td className="border-r border-[var(--border-subtle)] px-3 py-2 align-top whitespace-nowrap text-[13px] text-[var(--text-primary)] last:border-r-0">
              {p.children}
            </td>
          ),

          ...(trusted && {
            details: (p) => (
              <details className="my-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2">
                {p.children}
              </details>
            ),

            summary: (p) => (
              <summary className="cursor-pointer py-1 font-medium text-[var(--text-primary)]">
                {p.children}
              </summary>
            ),
          }),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
