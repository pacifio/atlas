// Implementation half of `./markdown`. Split out so the react-markdown +
// remark + rehype-highlight stack (~554 KB as `vendor-markdown`) is reachable
// only through the `lazy()` boundary in that file. `permission-modal.tsx` is
// rendered eagerly by `App.tsx`, so a static import of this stack anywhere in
// its graph put the whole pipeline in the entry chunk, parsed before first
// paint. Import THIS module directly only from code that is already lazy.

import { useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";
import { rehypeFileChips } from "./file-chip-hast";
import { openFileChipUnder, useFileChipHost } from "./file-chip-host";
import type { MarkdownProps } from "./markdown-props";

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
const PLAIN_REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [rehypeHighlight];

/**
 * Shared Markdown renderer used by the plans panel, canvas notes and the
 * notebook viewer. Styled overrides match the Atlas design tokens. With a
 * `fileRoot`, paths in it become chips that open in Atlas's viewer, inside
 * that folder only.
 */
export default function MarkdownImpl({ children, className, fileRoot }: MarkdownProps) {
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () =>
      fileRoot
        ? [
            [rehypeFileChips, { root: fileRoot, label: "basename", folders: false }],
            rehypeHighlight,
          ]
        : PLAIN_REHYPE_PLUGINS,
    [fileRoot],
  );
  const open = useMemo(() => (fileRoot ? openFileChipUnder(fileRoot) : null), [fileRoot]);
  const host = useFileChipHost(open);
  return (
    <div
      ref={host.ref}
      onClick={host.onClick}
      onKeyDown={host.onKeyDown}
      className={cn(
        "prose-chat text-[var(--foreground)] leading-relaxed break-words select-text",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={{
          code(props) {
            const { className, children, ...rest } = props as {
              className?: string;
              children?: React.ReactNode;
            };
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="px-1 py-0.5 rounded bg-[var(--card)] text-[var(--foreground)] text-sm font-mono"
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
            return (
              <pre
                className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-sm my-2 overflow-hidden"
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  overflowWrap: "anywhere",
                }}
              >
                {props.children}
              </pre>
            );
          },
          a(props) {
            return (
              <a
                {...props}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--primary)] underline hover:opacity-80"
              />
            );
          },
          ul(props) {
            return <ul className="list-disc pl-5 space-y-0.5 my-2">{props.children}</ul>;
          },
          ol(props) {
            return <ol className="list-decimal pl-5 space-y-0.5 my-2">{props.children}</ol>;
          },
          h1(props) {
            return <h1 className="text-base font-semibold mt-3 mb-1">{props.children}</h1>;
          },
          h2(props) {
            return <h2 className="text-sm font-semibold mt-3 mb-1">{props.children}</h2>;
          },
          h3(props) {
            return <h3 className="text-sm font-semibold mt-2 mb-1">{props.children}</h3>;
          },
          p(props) {
            return <p className="my-1.5">{props.children}</p>;
          },
          blockquote(props) {
            return (
              <blockquote className="border-l-2 border-[var(--border)] pl-3 my-2 text-[var(--secondary-foreground)]">
                {props.children}
              </blockquote>
            );
          },
          table(props) {
            return (
              <div className="my-3 rounded-md border border-[var(--border)] overflow-x-auto">
                <table className="w-max min-w-full text-sm border-collapse">{props.children}</table>
              </div>
            );
          },
          thead(props) {
            return <thead className="bg-[var(--card)]">{props.children}</thead>;
          },
          th(props) {
            return (
              <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--secondary-foreground)] border-b border-[var(--border)] border-r last:border-r-0">
                {props.children}
              </th>
            );
          },
          tr(props) {
            return (
              <tr className="border-b border-[var(--atlas-border-subtle)] last:border-b-0">
                {props.children}
              </tr>
            );
          },
          td(props) {
            return (
              <td className="px-3 py-2 align-top text-sm text-[var(--foreground)] border-r border-[var(--atlas-border-subtle)] last:border-r-0 break-words">
                {props.children}
              </td>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
