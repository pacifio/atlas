// Implementation half of `./markdown`. Split out so the react-markdown +
// remark + rehype-highlight stack (~554 KB as `vendor-markdown`) is reachable
// only through the `lazy()` boundary in that file. `permission-modal.tsx` is
// rendered eagerly by `App.tsx`, so a static import of this stack anywhere in
// its graph put the whole pipeline in the entry chunk, parsed before first
// paint. Import THIS module directly only from code that is already lazy.

import { useMemo, type ComponentProps } from "react";
import type { Components, Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { StreamingMarkdown } from "@tryatlas/design/session";
import { cn } from "@/lib/utils";
import { rehypeFileChips } from "./file-chip-hast";
import { openFileChipUnder, useFileChipHost } from "./file-chip-host";
import type { MarkdownProps } from "./markdown-props";

/** Highlighting as the chat engine does it (`markdown-render.ts`): a fence's
 *  named language only, never a guess, and plain text left plain. */
const HIGHLIGHT: NonNullable<Options["rehypePlugins"]>[number] = [
  rehypeHighlight,
  { detect: false, plainText: ["text", "plaintext"] },
];
const PLAIN_REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [HIGHLIGHT];

/** Every link opens outside the webview, never in it: a non-http link must not
 *  navigate Atlas away. */
function ExternalLink({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noreferrer" />;
}
const COMPONENTS: Components = { a: ExternalLink };

/**
 * Shared Markdown renderer used by the plans panel, the plan review, canvas
 * notes and the notebook viewer: the package's `StreamingMarkdown`, settled,
 * on the `.prose-session` typography. With a `fileRoot`, paths in it become
 * chips that open in Atlas's viewer, inside that folder only. Never
 * `rehype-raw`: HTML in the source renders as text.
 */
export default function MarkdownImpl({ children, className, fileRoot }: MarkdownProps) {
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () =>
      fileRoot
        ? [[rehypeFileChips, { root: fileRoot, label: "basename", folders: false }], HIGHLIGHT]
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
      className="atlas-prose-wrap"
    >
      <StreamingMarkdown
        source={children}
        streaming={false}
        rehypePlugins={rehypePlugins}
        components={COMPONENTS}
        className={cn("select-text", className)}
      />
    </div>
  );
}
