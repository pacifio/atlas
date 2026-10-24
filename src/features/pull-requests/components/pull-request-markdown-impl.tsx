// The renderer half of `pull-request-markdown.tsx`, reached only through its
// `lazy()` boundary so the remark/rehype stack stays out of the tab's first
// chunk.
//
// A pull request's body is GitHub-flavoured markdown with raw HTML in it
// (`<details>`, `<img width=…>`, `<picture>`), written by anyone who can
// open one. So: raw HTML is parsed (`rehype-raw`), then sanitised to GitHub's
// own allowlist (`rehype-sanitize`) before anything is highlighted or drawn.
// Images go through the `gh` image proxy, since the webview may load none
// from the network; links open in the system browser.
//
// File names become chips (`file-chip-hast.ts`), after the sanitiser, so
// nothing the body writes can forge one. One that names a changed file opens
// the Code tab at it (`pull-request-code-request.ts`); any other file in the
// checkout opens in Atlas's viewer. Nothing outside the checkout gets a chip,
// and no click reaches the system's opener, the file manager or an external
// editor (`openUntrustedPathLink`). Tables and code blocks wear collapse and
// copy buttons (`markdown-block-frame.tsx`).

import { memo, useCallback, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ExternalLink, ImageOff, Paperclip } from "lucide-react";
import "@/styles/hljs.css";

import { MarkdownBlockFrame } from "@/components/markdown-block-frame";
import { isWebUrl, openPullRequest } from "@/features/git/lib/git-pr-api";
import { rehypeFileChips, type FileChipPolicy } from "@/lib/file-chip-hast";
import { openFileChipUnder, useFileChipHost, type FileChipTarget } from "@/lib/file-chip-host";
import { cn } from "@/lib/utils";

import { usePrImage } from "../lib/pr-image";
import { usePullRequestChangedFiles } from "../lib/pull-request-changed-files";
import { requestPullRequestCodeFile } from "../lib/pull-request-code-request";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "../lib/pull-request-markdown";
import { usePullRequestScope } from "./pull-request-context";

/** GitHub's allowlist, plus the `<picture>`/`<source>` pair its dark-mode
 *  screenshots use and the sizing attributes images carry. */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "picture", "source"],
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "align"],
    source: ["srcSet", "media"],
  },
};

function ProxiedImage({ src, alt, width, height }: ComponentProps<"img">) {
  const { repoPath } = usePullRequestScope();
  const address = typeof src === "string" ? src : null;
  const objectUrl = usePrImage(repoPath, address);
  if (!address) return null;
  if (!objectUrl) {
    return (
      <button
        type="button"
        onClick={() => {
          if (isWebUrl(address)) openPullRequest(address);
        }}
        className="inline-flex max-w-full items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-element-hover hover:text-foreground"
      >
        <ImageOff aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{alt || "Image"}</span>
      </button>
    );
  }
  return (
    <img
      src={objectUrl}
      alt={alt ?? ""}
      width={width}
      height={height}
      className="my-1 inline-block h-auto max-w-full rounded align-middle"
    />
  );
}

// Headings, lists, code, tables and links take `.prose-chat`, the house
// markdown style (links in the info hue, a dotted underline on hover), so a
// pull request reads like every other piece of markdown in the app. Only
// what that stylesheet cannot do is overridden here.
const COMPONENTS: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          // A web page only: a relative or `file:` destination in text anyone
          // can write must never reach the system opener.
          if (href && isWebUrl(href)) openPullRequest(href);
        }}
      >
        {children}
      </a>
    );
  },
  img: ProxiedImage,
  // A `<source>` inside `<picture>` names an image the proxy would have to
  // fetch too; the `<img>` fallback beside it is enough.
  source: () => null,
  details: ({ children }) => <details className="my-2">{children}</details>,
  summary: ({ children }) => (
    <summary className="cursor-pointer text-secondary-foreground hover:text-foreground">
      {children}
    </summary>
  ),
  input: (props) => (
    // Task-list boxes: GitHub ticks them by editing the body, so here they only read.
    <input type="checkbox" checked={props.checked} readOnly disabled />
  ),
  table: ({ node: _node, ...props }) => (
    <MarkdownBlockFrame kind="table">
      <table {...props} />
    </MarkdownBlockFrame>
  ),
  pre: ({ node: _node, ...props }) => (
    <MarkdownBlockFrame kind="code">
      <pre {...props} />
    </MarkdownBlockFrame>
  ),
};

/** The chips' rules for a pull request: its checkout is the one root, its
 *  changed files are matched first, and a chip reads as the file's name. */
export function pullRequestChipPolicy(
  repoPath: string,
  changedFiles: readonly string[] | null,
): FileChipPolicy | null {
  if (!repoPath) return null;
  return {
    root: repoPath,
    label: "basename",
    folders: false,
    ...(changedFiles?.length ? { changedFiles } : {}),
  };
}

function AttachmentLink({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (isWebUrl(url)) openPullRequest(url);
      }}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-xs hover:bg-element-hover"
    >
      <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Open attachment on GitHub</span>
      <ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

export default memo(function PullRequestMarkdownImpl({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { repositoryUrl, repoPath, number } = usePullRequestScope();
  const changedFiles = usePullRequestChangedFiles(repoPath, number);
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(
    () =>
      repositoryUrl ? [remarkGfm, [remarkPullRequestAutolinks, { repositoryUrl }]] : [remarkGfm],
    [repositoryUrl],
  );
  // The chips run after the sanitiser: they are Atlas's own markup, and
  // nothing the body writes reaches them.
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () => [
      rehypeRaw,
      [rehypeSanitize, SANITIZE_SCHEMA],
      [rehypeFileChips, pullRequestChipPolicy(repoPath, changedFiles)],
      rehypeHighlight,
    ],
    [repoPath, changedFiles],
  );
  const openChip = useCallback(
    (target: FileChipTarget) => {
      if (
        target.prFile &&
        requestPullRequestCodeFile(repoPath, number, target.prFile, target.line)
      ) {
        return;
      }
      openFileChipUnder(repoPath)(target);
    },
    [repoPath, number],
  );
  const { ref, onClick, onKeyDown } = useFileChipHost(openChip);
  // Parsed and drawn once per text, repository and changed-file list: the
  // scope above changes for reasons of its own (an agent action starting),
  // and every block on the page would otherwise re-run the whole
  // remark/rehype pipeline. The same element tree back lets React skip the
  // subtree.
  return useMemo(
    () => (
      <div
        ref={ref}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          "prose-chat min-w-0 text-sm leading-relaxed break-words text-foreground select-text",
          className,
        )}
      >
        {splitPullRequestBody(text).map((segment) =>
          segment.kind === "markdown" || segment.media === "image" ? (
            <ReactMarkdown
              key={segment.id}
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={COMPONENTS}
            >
              {segment.kind === "markdown" ? segment.text : `![](<${segment.url}>)`}
            </ReactMarkdown>
          ) : (
            <AttachmentLink key={segment.id} url={segment.url} />
          ),
        )}
      </div>
    ),
    [text, className, remarkPlugins, rehypePlugins, ref, onClick, onKeyDown],
  );
});
