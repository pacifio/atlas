// Chat-message renderer: the lazy boundary, the member directory, and nothing
// else. The pipeline itself is `./message-body-impl`.
//
// This used to be a hand-written parser, on the stated grounds that mentions
// have to resolve against the member directory at render time and that feeding
// `<@u_id>` through a sanitizing markdown pass would yield "either an escaped
// literal or a stripped span". That is true of a markdown→HTML→sanitize
// pipeline. It is NOT true of a remark plugin working on the syntax tree: the
// token never becomes HTML, it becomes an mdast node that react-markdown hands
// to a React component, which reads the directory through context on every
// render. See `../lib/remark-comms-inline` for why a mention inside code is
// safer under this design than it was under the old regex ordering.
//
// What survives from that reasoning: this is deliberately NOT the agent chat's
// `CachedMarkdown`. That pipeline caches HTML strings in a process-wide LRU
// keyed by source text — which would bake a member's name, or a momentarily
// empty roster's `@unknown`, into a cache entry that outlives the rename. A
// chat message is also settled the moment it lands, so the worker, the
// priority queue and the streaming tail lane have nothing to do here.
//
// The highlight.js stylesheet is imported HERE, on the eager side, for the same
// reason `src/lib/markdown.tsx` does it: it is small, and keeping it out of the
// lazy chunk means a code fence never paints unstyled for a frame.

import { lazy, memo, Suspense, useMemo } from "react";
import "highlight.js/styles/github-dark.css";
import { cn } from "@/lib/utils";
import { MentionContext } from "./message-body-context";
import type { OrgMemberProfile } from "../types";

const MessageBodyImpl = lazy(() => import("./message-body-impl"));

/** Start fetching the markdown chunk. Called when the comms panel mounts. */
export function primeCommsMarkdown(): void {
  void import("./message-body-impl");
}

interface MessageBodyProps {
  body: string;
  members: Map<string, OrgMemberProfile>;
  /** The current user — a mention of them is styled differently. */
  me: string;
  className?: string;
}

export const MessageBody = memo(function MessageBody({
  body,
  members,
  me,
  className,
}: MessageBodyProps) {
  const directory = useMemo(() => ({ members, me }), [members, me]);

  return (
    <div className={cn("text-[12.5px] leading-[1.5] break-words", className)}>
      <MentionContext.Provider value={directory}>
        <Suspense
          fallback={
            // Unformatted beats absent, and the height has to match: the
            // transcript pins to the bottom by writing a sentinel `scrollTop`
            // without ever reading `scrollHeight`, so a body that grows taller
            // after the swap would leave the view stranded above the latest
            // message. Same type scale, and `pre-wrap` so a plain multi-line
            // message — the overwhelmingly common case — occupies exactly its
            // final height.
            <div className="whitespace-pre-wrap">{body}</div>
          }
        >
          <MessageBodyImpl body={body} />
        </Suspense>
      </MentionContext.Provider>
    </div>
  );
});
