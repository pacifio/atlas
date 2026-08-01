import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  children: string;
  className?: string;
}

/**
 * Shared Markdown renderer used by the chat assistant bubbles and the canvas
 * note cards/inspector. Styled overrides match the Atlas design tokens.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
}: MarkdownProps) {
  return (
    <div
      className={cn(
        "prose-chat text-[var(--text-primary)] leading-relaxed break-words select-text",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
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
                  className="px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] text-[12px] font-mono"
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
                className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-[12px] my-2 overflow-hidden"
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
                className="text-[var(--accent-primary)] underline hover:opacity-80"
              />
            );
          },
          ul(props) {
            return (
              <ul className="list-disc pl-5 space-y-0.5 my-2">
                {props.children}
              </ul>
            );
          },
          ol(props) {
            return (
              <ol className="list-decimal pl-5 space-y-0.5 my-2">
                {props.children}
              </ol>
            );
          },
          h1(props) {
            return (
              <h1 className="text-base font-semibold mt-3 mb-1">
                {props.children}
              </h1>
            );
          },
          h2(props) {
            return (
              <h2 className="text-sm font-semibold mt-3 mb-1">
                {props.children}
              </h2>
            );
          },
          h3(props) {
            return (
              <h3 className="text-sm font-semibold mt-2 mb-1">
                {props.children}
              </h3>
            );
          },
          p(props) {
            return <p className="my-1.5">{props.children}</p>;
          },
          blockquote(props) {
            return (
              <blockquote className="border-l-2 border-[var(--border-default)] pl-3 my-2 text-[var(--text-secondary)]">
                {props.children}
              </blockquote>
            );
          },
          table(props) {
            return (
              <div className="my-3 rounded-md border border-[var(--border-default)] overflow-hidden">
                <table className="w-full text-[12px] border-collapse">
                  {props.children}
                </table>
              </div>
            );
          },
          thead(props) {
            return (
              <thead className="bg-[var(--bg-elevated)]">
                {props.children}
              </thead>
            );
          },
          th(props) {
            return (
              <th className="px-3 py-2 text-left text-[11px] font-semibold text-[var(--text-secondary)] border-b border-[var(--border-default)] border-r last:border-r-0">
                {props.children}
              </th>
            );
          },
          tr(props) {
            return (
              <tr className="border-b border-[var(--border-subtle)] last:border-b-0">
                {props.children}
              </tr>
            );
          },
          td(props) {
            return (
              <td className="px-3 py-2 align-top text-[12px] text-[var(--text-primary)] border-r border-[var(--border-subtle)] last:border-r-0 break-words">
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
});
