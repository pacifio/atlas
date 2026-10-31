import { memo, useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { rehypeFileChips, type FileChipPolicy } from "@/lib/file-chip-hast";
import { openFileChipUnder, useFileChipHost } from "@/lib/file-chip-host";
import { documentFileRoot } from "@/lib/file-links";
import { onMarkdownClick } from "@/lib/markdown-links";
import { cachedPreviewImage, previewImage } from "@/lib/markdown-preview-image";
import { PREVIEW_SANITIZE_SCHEMA } from "@/lib/markdown-sanitize";
import "@/styles/hljs.css";

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

const IMG_CLASS = "my-1 inline-block h-auto max-w-full rounded align-middle";

/**
 * An image whose bytes come from Rust (`previewImage`): remote ones because
 * the CSP refuses them, relative ones because they resolve against the app,
 * not the document. Keeps its `width`/`height` while loading so the layout
 * does not jump, and falls back to its alt text if it cannot be had.
 */
function PreviewImage({
  docPath,
  src,
  alt,
  ...rest
}: ComponentPropsWithoutRef<"img"> & { docPath: string; src: string }) {
  const [url, setUrl] = useState(() => cachedPreviewImage(docPath, src));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    previewImage(docPath, src).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [docPath, src]);
  if (failed && !url) {
    return alt ? <span className="text-[var(--muted-foreground)]">{alt}</span> : null;
  }
  return <img {...rest} alt={alt} src={url} className={IMG_CLASS} />;
}

/**
 * A web link opens in the system browser; nothing else may navigate the
 * window away from the app (a relative `docs/x.md` would otherwise load
 * `tauri://localhost/docs/x.md` over Atlas). In-page `#anchors` still scroll.
 */
function onPreviewLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  if (onMarkdownClick(e.nativeEvent)) return;
  if (e.currentTarget.getAttribute("href")?.startsWith("#")) return;
  e.preventDefault();
}

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
  /**
   * Absolute path of the document. With `trusted`, images are loaded through
   * Rust against it — relative paths from its folder, remote URLs past the
   * CSP — instead of by the webview, which can do neither.
   */
  docPath?: string;
  /**
   * The project the document belongs to. File paths in it become chips that
   * open in Atlas's viewer, inside this folder only (outside every project,
   * the document's own folder: `documentFileRoot`). Unset, no chips.
   */
  projectRoot?: string | null;
  className?: string;
}
export const MarkdownFile = memo(function MarkdownFile({
  children,
  trusted = false,
  docPath,
  projectRoot,
}: Props) {
  // File paths become chips rooted at the document's project; relative links
  // resolve from the document's own folder. They are added after the
  // sanitiser, so the document's raw HTML cannot forge one, and a click opens
  // Atlas's viewer or nothing.
  const fileRoot = projectRoot === undefined ? null : documentFileRoot(docPath, projectRoot);
  const docDir = docPath ? documentFileRoot(docPath, null) : null;
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(() => {
    const policy: FileChipPolicy | null = fileRoot
      ? {
          root: fileRoot,
          ...(docDir ? { linkBase: docDir } : {}),
          label: "basename",
          folders: false,
        }
      : null;
    return trusted
      ? [
          rehypeRaw,
          [rehypeSanitize, PREVIEW_SANITIZE_SCHEMA],
          [rehypeFileChips, policy],
          rehypeHighlight,
        ]
      : [[rehypeFileChips, policy], rehypeHighlight];
  }, [trusted, fileRoot, docDir]);
  const open = useMemo(() => (fileRoot ? openFileChipUnder(fileRoot) : null), [fileRoot]);
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
            <h1 className="mt-8 mb-3 border-b border-[var(--border)] pb-2 text-2xl font-bold tracking-tight">
              {p.children}
            </h1>
          ),

          h2: (p) => (
            <h2 className="mt-7 mb-3 border-b border-[var(--atlas-border-subtle)] pb-1.5 text-xl font-semibold tracking-tight">
              {p.children}
            </h2>
          ),

          h3: (p) => <h3 className="mt-6 mb-2 text-lg font-semibold">{p.children}</h3>,

          h4: (p) => <h4 className="mt-4 mb-1.5 text-md font-semibold">{p.children}</h4>,

          p: (p) => <p className="my-3">{p.children}</p>,

          a: ({ node: _node, ...p }) => (
            <a
              {...p}
              target="_blank"
              rel="noreferrer"
              onClick={onPreviewLinkClick}
              className="text-[var(--primary)] underline hover:opacity-80"
            />
          ),

          ul: (p) => <ul className="my-3 list-disc space-y-1 pl-6">{p.children}</ul>,

          ol: (p) => <ol className="my-3 list-decimal space-y-1 pl-6">{p.children}</ol>,

          li: (p) => <li className="leading-relaxed">{p.children}</li>,

          img: ({ node: _node, ...p }) =>
            trusted && docPath && typeof p.src === "string" ? (
              <PreviewImage {...p} docPath={docPath} src={p.src} />
            ) : (
              // oxlint-disable-next-line jsx-a11y/alt-text
              <img {...p} className={IMG_CLASS} />
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
                  className="rounded bg-[var(--card)] px-1.5 py-0.5 font-mono text-base text-[var(--foreground)]"
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
              className="my-4 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--card)] text-base"
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
            <blockquote className="my-3 border-l-2 border-[var(--border)] pl-4 text-[var(--secondary-foreground)]">
              {p.children}
            </blockquote>
          ),

          hr: () => <hr className="my-6 border-[var(--atlas-border-subtle)]" />,

          table: (p) => (
            <div
              className="my-4 overflow-x-auto rounded-md border border-[var(--border)]"
              onWheel={handleWheel}
            >
              <table className="min-w-max text-base">{p.children}</table>
            </div>
          ),

          thead: (p) => <thead className="bg-[var(--card)]">{p.children}</thead>,

          tr: (p) => (
            <tr className="border-b border-[var(--atlas-border-subtle)] last:border-b-0">
              {p.children}
            </tr>
          ),

          th: (p) => (
            <th className="border-r border-[var(--border)] border-b border-[var(--border)] px-3 py-2 text-left text-sm font-semibold whitespace-nowrap text-[var(--secondary-foreground)] last:border-r-0">
              {p.children}
            </th>
          ),

          td: (p) => (
            <td className="border-r border-[var(--atlas-border-subtle)] px-3 py-2 align-top whitespace-nowrap text-base text-[var(--foreground)] last:border-r-0">
              {p.children}
            </td>
          ),

          ...(trusted && {
            details: (p) => (
              <details className="my-3 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2">
                {p.children}
              </details>
            ),

            summary: (p) => (
              <summary className="cursor-pointer py-1 font-medium text-[var(--foreground)]">
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
