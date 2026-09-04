// Git-diff syntax-highlight worker. Tokenizes a whole file's diff lines with
// lowlight OFF the main thread, so scrolling/jumping a large diff never blocks
// on synchronous highlight.js (the cost that made the diff feel like ~15fps and
// jumps take ~800ms). The main thread posts `{ id, hljsId, lines }` (one batch
// per file) and gets back `{ id, tokens }` in the same order; correlation +
// caching live in `diff-highlight-cache.ts`.
//
// `self` is typed manually rather than via the `webworker` lib to avoid
// conflicting with the DOM lib in the project's single tsconfig (mirrors
// `markdown.worker.ts`).

import { tokenizeLine, type DiffToken } from "./diff-highlight-core";

interface HighlightRequest {
  id: number;
  hljsId: string;
  lines: string[];
}
interface HighlightResponse {
  id: number;
  tokens: (DiffToken[] | null)[];
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<HighlightRequest>) => void) | null;
  postMessage: (msg: HighlightResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, hljsId, lines } = e.data;
  const tokens = lines.map((line) => tokenizeLine(hljsId, line));
  ctx.postMessage({ id, tokens });
};
