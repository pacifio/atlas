import { memo, useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { PREVIEW_SANITIZE_SCHEMA } from "@/lib/markdown-sanitize";
import { rehypeFileChips } from "@/lib/file-chip-hast";
import { openFileChipUnder, useFileChipHost } from "@/lib/file-chip-host";
import "@/styles/hljs.css";

interface Props {
  source: string;
  /** The repository the README belongs to: file paths in it become chips
   *  that open in Atlas's viewer, inside this folder only. */
  root?: string | null;
}

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

/**
 * Read-only README viewer for the KB repo section. The shared `<Markdown>`
 * helper is tuned for chat bubbles; this one renders long-form docs at
 * doc-scale and via `rehype-raw` allows the raw HTML (`<h1 align="...">`,
 * `<details>`, `<img>`, …) that most GitHub READMEs depend on.
 *
 * The raw HTML goes through the same allowlist as the markdown preview
 * (`markdown-sanitize.ts`): a cloned repo's README is not trusted code.
 *
 * File chips are drawn after the raw HTML is parsed. Raw HTML could write a
 * span that looks like one, but a click re-resolves the path inside `root`
 * (`openUntrustedPathLink`), so a look-alike opens nothing the real chip
 * could not.
 */
export const ReadmeView = memo(function ReadmeView({ source, root }: Props) {
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () => [
      rehypeRaw,
      [rehypeSanitize, PREVIEW_SANITIZE_SCHEMA],
      [rehypeFileChips, root ? { root, label: "basename", folders: false } : null],
      rehypeHighlight,
    ],
    [root],
  );
  const open = useMemo(() => (root ? openFileChipUnder(root) : null), [root]);
  const host = useFileChipHost(open);
  return (
    <div
      ref={host.ref}
      onClick={host.onClick}
      onKeyDown={host.onKeyDown}
      className="text-md leading-relaxed text-[var(--foreground)] break-words select-text"
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={{
          h1: (p) => (
            <h1 className="text-2xl font-bold tracking-tight mt-8 mb-3 pb-2 border-b border-[var(--border)]">
              {p.children}
            </h1>
          ),
          h2: (p) => (
            <h2 className="text-xl font-semibold tracking-tight mt-7 mb-3 pb-1.5 border-b border-[var(--atlas-border-subtle)]">
              {p.children}
            </h2>
          ),
          h3: (p) => <h3 className="text-lg font-semibold mt-6 mb-2">{p.children}</h3>,
          h4: (p) => <h4 className="text-md font-semibold mt-4 mb-1.5">{p.children}</h4>,
          p: (p) => <p className="my-3">{p.children}</p>,
          a: (p) => (
            <a
              {...p}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--primary)] underline hover:opacity-80"
            />
          ),
          ul: (p) => <ul className="list-disc pl-6 space-y-1 my-3">{p.children}</ul>,
          ol: (p) => <ol className="list-decimal pl-6 space-y-1 my-3">{p.children}</ol>,
          li: (p) => <li className="leading-relaxed">{p.children}</li>,
          img: (p) => (
            // eslint-disable-next-line jsx-a11y/alt-text
            <img {...p} className="inline-block max-w-full h-auto rounded my-1 align-middle" />
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
                  className="px-1.5 py-0.5 rounded bg-[var(--card)] text-[var(--foreground)] text-base font-mono"
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
              className="rounded-md border border-[var(--border)] bg-[var(--card)] p-4 text-base my-4 overflow-x-auto"
              style={{ whiteSpace: "pre", wordBreak: "normal" }}
            >
              {p.children}
            </pre>
          ),
          blockquote: (p) => (
            <blockquote className="border-l-2 border-[var(--border)] pl-4 my-3 text-[var(--secondary-foreground)]">
              {p.children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-[var(--atlas-border-subtle)]" />,
          table: (p) => (
            <div className="my-4 rounded-md border border-[var(--border)] overflow-x-auto">
              <table className="w-full text-base border-collapse">{p.children}</table>
            </div>
          ),
          thead: (p) => <thead className="bg-[var(--card)]">{p.children}</thead>,
          th: (p) => (
            <th className="px-3 py-2 text-left text-sm font-semibold text-[var(--secondary-foreground)] border-b border-[var(--border)] border-r last:border-r-0">
              {p.children}
            </th>
          ),
          tr: (p) => (
            <tr className="border-b border-[var(--atlas-border-subtle)] last:border-b-0">
              {p.children}
            </tr>
          ),
          td: (p) => (
            <td className="px-3 py-2 align-top text-base text-[var(--foreground)] border-r border-[var(--atlas-border-subtle)] last:border-r-0 break-words">
              {p.children}
            </td>
          ),
          details: (p) => (
            <details className="my-3 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2">
              {p.children}
            </details>
          ),
          summary: (p) => (
            <summary className="cursor-pointer font-medium text-[var(--foreground)] py-1">
              {p.children}
            </summary>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
