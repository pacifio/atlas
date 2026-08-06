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
// The highlight.js stylesheet stays HERE, not in the impl: it is small, and
// keeping it on the eager side means formatted code never renders unstyled for
// a frame while the impl chunk loads.

import { lazy, memo, Suspense } from "react";
import "highlight.js/styles/github-dark.css";
import { cn } from "@/lib/utils";
import type { MarkdownProps } from "./markdown-props";

const MarkdownImpl = lazy(() => import("./markdown-impl"));

/** Start loading the markdown renderer chunk. Call once after first paint so
 *  the fallback below is never actually seen. */
export function primeMarkdown(): void {
  void import("./markdown-impl");
}

/**
 * Shared Markdown renderer used by the chat assistant bubbles and the canvas
 * note cards/inspector. Styled overrides match the Atlas design tokens.
 */
export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
  return (
    <Suspense
      fallback={
        // Unformatted beats absent: same text, same type scale, so the block
        // occupies about its final height and is readable immediately.
        <div
          className={cn(
            "prose-chat text-[var(--text-primary)] leading-relaxed break-words select-text whitespace-pre-wrap",
            className,
          )}
        >
          {children}
        </div>
      }
    >
      <MarkdownImpl className={className}>{children}</MarkdownImpl>
    </Suspense>
  );
});
