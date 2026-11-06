// Lazy boundary in front of the react-markdown pipeline.
//
// The renderer itself lives in `./markdown-impl`. It is reached through
// `lazy()` because several of this component's callers sit on the eager boot
// path — `permission-modal.tsx` is rendered directly by `App.tsx` — and a
// static import chain from there put react-markdown + remark-gfm +
// rehype-highlight (the ~554 KB `vendor-markdown` chunk) into the entry chunk,
// where it was parsed before React's first paint. Every consumer keeps the same
// `<Markdown>` API; only the first render in a session waits on the chunk, and
// `primeMarkdown()` removes even that.
//
// The highlight.js token colours are the package's `syntax.css` (theme keys),
// loaded eagerly with the rest of its styles, so formatted code never renders
// uncoloured for a frame while the impl chunk loads.

import { lazy, memo, Suspense } from "react";
import { cn } from "@/lib/utils";
import type { MarkdownProps } from "./markdown-props";

const MarkdownImpl = lazy(() => import("./markdown-impl"));

/** Start loading the markdown renderer chunk. Call once after first paint so
 *  the fallback below is never actually seen. */
export function primeMarkdown(): void {
  void import("./markdown-impl");
}

/**
 * Shared Markdown renderer for the plans panel, the plan review, canvas notes
 * and the notebook viewer, on the package's `.prose-session` typography.
 */
export const Markdown = memo(function Markdown({ children, className, fileRoot }: MarkdownProps) {
  return (
    <Suspense
      fallback={
        // Unformatted beats absent: same text, same type scale, so the block
        // occupies about its final height and is readable immediately.
        <div className={cn("prose-session whitespace-pre-wrap select-text", className)}>
          {children}
        </div>
      }
    >
      <MarkdownImpl className={className} fileRoot={fileRoot}>
        {children}
      </MarkdownImpl>
    </Suspense>
  );
});
