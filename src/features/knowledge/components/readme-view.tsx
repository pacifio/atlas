import { memo, useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Image as ImageIcon } from "lucide-react";
import { Icon } from "@tryatlas/design";
import { PREVIEW_SANITIZE_SCHEMA } from "@/lib/markdown-sanitize";
import { rehypeFileChips } from "@/lib/file-chip-hast";
import { openFileChipUnder, useFileChipHost } from "@/lib/file-chip-host";
import "../readme.css";

interface Props {
  source: string;
  /** The repository the README belongs to: file paths in it become chips
   *  that open in Atlas's viewer, inside this folder only. */
  root?: string | null;
}

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

/**
 * Read-only README viewer for the KB repo section, on the package's
 * `.prose-session` typography at document scale (`readme.css`). Via
 * `rehype-raw` it allows the raw HTML (`<h1 align="...">`,
 * `<details>`, …) that most GitHub READMEs depend on. Images show as their
 * alt text, never fetched (`README_COMPONENTS.img`).
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
      data-view="readme"
      className="prose-session select-text"
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={README_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

/** A link the system browser (or mail client) can open. Anything else in a
 *  README — a relative path, a `#heading` — points into the repo's own
 *  GitHub page and has nowhere to go here. */
const EXTERNAL_HREF = /^(?:https?:|mailto:)/i;

/** What an image stands in as: its alt text, else its file name. */
function imageLabel(alt: string | undefined, src: unknown): string {
  if (alt?.trim()) return alt.trim();
  const name = typeof src === "string" ? src.split(/[?#]/)[0].split("/").pop() : "";
  return name || "image";
}

// Typography is `.prose-session` plus `readme.css`. A table gets a scroll box
// so a wide one scrolls inside it rather than pushing the column (the table
// keeps `display: table` and so its table semantics).
const README_COMPONENTS: NonNullable<Options["components"]> = {
  // A web or mail link opens outside Atlas: navigating the webview would
  // replace the app. A relative or anchor link does nothing; its tooltip says
  // where it points.
  a: ({ node: _node, href, title, onClick: _onClick, ...p }) => {
    const external = !!href && EXTERNAL_HREF.test(href);
    return (
      <a
        {...p}
        href={href}
        title={external ? title : (title ?? href)}
        onClick={(e) => {
          e.preventDefault();
          if (external && href) void openUrl(href).catch(() => {});
        }}
      />
    );
  },
  // Never an <img>: a README's images are remote (a tracking pixel fetches
  // the moment it renders) or repo-relative (which the webview cannot load).
  // The image's alt text stands in its place, muted, with its address on hover.
  img: ({ alt, src }) => (
    <span
      title={typeof src === "string" ? src : undefined}
      className="inline-flex items-center gap-1 align-baseline text-muted-foreground"
    >
      <Icon icon={ImageIcon} size="xs" className="shrink-0" />
      {imageLabel(alt, src)}
    </span>
  ),
  table: ({ node: _node, ...p }) => (
    <div className="overflow-x-auto">
      <table {...p} />
    </div>
  ),
};
