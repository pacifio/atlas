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

// Typography is `.prose-session` plus `readme.css`; only the link keeps an
// override, for its target.
const README_COMPONENTS: NonNullable<Options["components"]> = {
  a: ({ node: _node, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
};
